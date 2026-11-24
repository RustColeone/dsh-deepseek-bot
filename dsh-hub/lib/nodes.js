// The hub's side of its nodes: the other computers, each running DSH (or `dsh-hub node`) and connected out to the hub,
// so a node opens no port of its own and works from behind any router.
//
// Joining: the owner asks the hub for a pairing code for a computer's name (it answers once, within 10 minutes); the
// computer sends it to POST /api/nodes/enroll and gets its id and a 32-byte secret, which only it keeps (the hub keeps
// the SHA-256). From then on it opens the websocket /node with `Authorization: Bearer <id>.<secret>`.
//
// The wire (JSON, one object per message):
//   hub → node   { t: 'call', id, op, args }         op: info | exec | cancel | jobs
//   node → hub   { t: 'result', id, ok, value, error }
//                { t: 'hello', info, jobs }          first, and again after every reconnect
//                { t: 'job', job, event: 'output', stream, data } | { t: 'job', job, event: 'exit', code, signal, error }
//
// A job is one command run on a node. Its output is kept here (the last 256 KB of it) while it runs and after, so
// a chat can look at it later; the node keeps running it if the connection drops and says how it went when it is back.
import crypto from 'node:crypto'
import { sha256, Throttle } from './auth.js'
import { now } from './store.js'

export const PROTOCOL = 1
const PAIRING_MINUTES = 10
const KEEP = 256 * 1024 // characters of a job's output kept
const JOBS = 300 // jobs remembered
const CALL_SECONDS = 30
const NODE_NAME = /^[\p{L}\p{N}][\p{L}\p{N} _.'-]{0,39}$/u

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const code = () => Array.from(crypto.randomBytes(8), byte => alphabet[byte % alphabet.length]).join('').replace(/^(.{4})/, '$1-')
const normalCode = text => String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '')

export function checkNodeName (name) {
  return NODE_NAME.test(String(name || '').trim()) ? '' : 'A computer\'s name is 1 to 40 letters, digits, spaces, dots, dashes or apostrophes.'
}

class Job {
  constructor ({ id, node, command, cwd, shell, by, chat }) {
    Object.assign(this, { id, node: node.id, nodeName: node.name, command, cwd: cwd || '', shell: shell || '',
      by: by || '', chat: chat || '', status: 'starting', code: null, error: '', started: now(), ended: null })
    this.output = ''
    this.dropped = 0
    this.waiters = new Set()
  }
  get done () { return !['starting', 'running'].includes(this.status) }
  add (data) {
    this.output += data
    if (this.output.length > KEEP) {
      const cut = this.output.length - KEEP
      this.output = this.output.slice(cut)
      this.dropped += cut
    }
  }
  finish (status, { code = null, error = '' } = {}) {
    if (this.done) return
    Object.assign(this, { status, code, error, ended: now() })
    for (const waiter of this.waiters) waiter()
    this.waiters.clear()
  }
  /** Resolves when the job ends or after `seconds`, whichever comes first. */
  wait (seconds, signal) {
    if (this.done) return Promise.resolve()
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); this.waiters.delete(done); resolve() }
      const timer = setTimeout(done, Math.max(0, seconds) * 1000)
      signal?.addEventListener('abort', done, { once: true })
      this.waiters.add(done)
    })
  }
  tail (characters = 4000) {
    const text = this.output.slice(-characters)
    const cut = this.output.length - text.length + this.dropped
    return cut > 0 ? `[… ${cut} earlier characters not shown]\n${text}` : text
  }
  view (characters = 0) {
    return { id: this.id, node: this.nodeName, command: this.command, cwd: this.cwd, status: this.status,
      code: this.code, error: this.error || undefined, started: this.started, ended: this.ended,
      seconds: Math.round(((this.ended ?? now()) - this.started) * 10) / 10,
      ...(characters ? { output: this.tail(characters) } : {}) }
  }
}

export class Nodes {
  constructor (store, { log = () => {}, onChange = () => {}, onJob = () => {} } = {}) {
    this.store = store
    this.log = log
    this.onChange = onChange
    this.onJob = onJob
    this.links = new Map() // node id -> { ws, info, calls: Map }
    this.jobs = new Map()
    this.enrolls = new Throttle({ limit: 10, window: 600, lock: 600 })
  }

  // ---- joining --------------------------------------------------------------------------------------
  /** A pairing code for a computer to join as `name`, shown to the owner who asked. */
  pair (name, user) {
    const problem = checkNodeName(name)
    if (problem) return { error: problem }
    if (this.store.nodeByName(name.trim())) return { error: `A computer is already called ${name.trim()}.` }
    const value = code()
    const expires = now() + PAIRING_MINUTES * 60
    this.store.addPairing(sha256(normalCode(value)), name.trim(), expires, user.id)
    this.log('pairing_made', { name: name.trim(), by: user.name })
    return { code: value, name: name.trim(), expires }
  }

  /** A computer joins with its pairing code. Returns { id, secret, name } or { error }. */
  enroll ({ code: given, info }, address) {
    if (this.enrolls.locked(address) || this.enrolls.locked('*')) return { error: 'Too many tries. Wait a while.', status: 429 }
    const pairing = this.store.takePairing(sha256(normalCode(given)))
    if (!pairing) {
      this.enrolls.fail(address)
      this.enrolls.fail('*')
      return { error: 'That pairing code is wrong, used or expired. Ask the hub for a new one.', status: 403 }
    }
    if (this.store.nodeByName(pairing.name)) return { error: `A computer is already called ${pairing.name}.`, status: 409 }
    const id = `n${crypto.randomBytes(6).toString('hex')}`
    const secret = crypto.randomBytes(32).toString('base64url')
    this.store.addNode({ id, name: pairing.name, secret: sha256(secret), info: clean(info) })
    this.log('node_joined', { id, name: pairing.name, address })
    this.onChange()
    return { id, secret, name: pairing.name, protocol: PROTOCOL }
  }

  /** The node an Authorization header proves, or null. */
  authenticate (header) {
    const match = /^Bearer (n[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/.exec(String(header || ''))
    if (!match) return null
    const kept = this.store.nodeSecret(match[1])
    if (!kept) return null
    const given = sha256(match[2])
    return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(kept)) ? this.store.node(match[1]) : null
  }

  // ---- connections ----------------------------------------------------------------------------------
  attach (node, ws) {
    const old = this.links.get(node.id)
    if (old) old.ws.close(4409, 'replaced by a newer connection')
    const link = { ws, info: node.info, calls: new Map(), alive: true }
    this.links.set(node.id, link)
    this.store.updateNode(node.id, { seen: now() })
    this.log('node_online', { name: node.name })
    ws.on('message', data => {
      let message
      try { message = JSON.parse(String(data)) } catch { return }
      try { this.#receive(node.id, link, message) } catch (error) { this.log('node_message_failed', { name: node.name, error: String(error) }) }
    })
    ws.on('pong', () => { link.alive = true })
    ws.on('close', () => {
      if (this.links.get(node.id) !== link) return
      this.links.delete(node.id)
      for (const { reject, timer } of link.calls.values()) { clearTimeout(timer); reject(new Error('the computer went offline')) }
      this.store.updateNode(node.id, { seen: now() })
      this.log('node_offline', { name: node.name })
      this.onChange()
    })
    this.onChange()
  }

  /** Every 30 seconds: a node that didn't answer the last ping is gone. */
  heartbeat () {
    for (const [id, link] of this.links) {
      if (!link.alive) { link.ws.terminate(); continue }
      link.alive = false
      try { link.ws.ping() } catch { this.links.delete(id) }
    }
  }

  #receive (id, link, message) {
    if (message.t === 'hello') {
      link.info = clean(message.info)
      this.store.updateNode(id, { info: link.info, seen: now() })
      this.#resync(id, Array.isArray(message.jobs) ? message.jobs : [])
      this.onChange()
    } else if (message.t === 'result') {
      const call = link.calls.get(message.id)
      if (!call) return
      link.calls.delete(message.id)
      clearTimeout(call.timer)
      if (message.ok) call.resolve(message.value)
      else call.reject(new Error(String(message.error || 'the computer refused')))
    } else if (message.t === 'job') {
      const job = this.jobs.get(message.job)
      if (!job || job.node !== id) return
      if (message.event === 'output') {
        if (job.status === 'starting') job.status = 'running'
        job.add(String(message.data ?? ''))
        this.onJob(job, 'output')
      } else if (message.event === 'exit') {
        const code = Number.isInteger(message.code) ? message.code : null
        job.finish(message.cancelled ? 'cancelled' : code === 0 ? 'done' : 'failed', { code, error: String(message.error || '') })
        this.onJob(job, 'exit')
      }
    }
  }

  /** After a reconnect: jobs the node still has carry on; ours it no longer knows were lost. */
  #resync (id, reported) {
    const byId = new Map(reported.map(item => [item.job, item]))
    for (const job of this.jobs.values()) {
      if (job.node !== id || job.done) continue
      const found = byId.get(job.id)
      if (!found) { job.finish('lost', { error: 'the computer restarted and no longer knows this job' }); this.onJob(job, 'exit'); continue }
      if (found.tail && found.tail.length > job.output.length) job.output = String(found.tail).slice(-KEEP)
      if (found.status === 'running') job.status = 'running'
      else {
        job.finish(found.cancelled ? 'cancelled' : found.code === 0 ? 'done' : 'failed', { code: found.code ?? null, error: found.error || '' })
        this.onJob(job, 'exit')
      }
    }
  }

  call (id, op, args = {}, seconds = CALL_SECONDS) {
    const link = this.links.get(id)
    if (!link) return Promise.reject(new Error('that computer is offline'))
    const callId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { link.calls.delete(callId); reject(new Error('the computer did not answer')) }, seconds * 1000)
      link.calls.set(callId, { resolve, reject, timer })
      link.ws.send(JSON.stringify({ t: 'call', id: callId, op, args }))
    })
  }

  // ---- what the hub and its tools use ---------------------------------------------------------------
  online (id) { return this.links.has(id) }

  list () {
    return this.store.nodes().map(node => ({
      id: node.id, name: node.name, policy: node.policy, online: this.links.has(node.id),
      info: this.links.get(node.id)?.info ?? node.info, seen: node.seen, created: node.created,
      running: [...this.jobs.values()].filter(job => job.node === node.id && !job.done).length,
    }))
  }

  /** The node a name means: exactly, else the only one whose name contains it, else null. */
  find (name) {
    const text = String(name || '').trim().toLowerCase()
    if (!text) return null
    const nodes = this.store.nodes()
    const exact = nodes.find(node => node.name.toLowerCase() === text || node.id === text)
    if (exact) return exact
    const near = nodes.filter(node => node.name.toLowerCase().includes(text) ||
      String(node.info.hostname || '').toLowerCase() === text)
    return near.length === 1 ? near[0] : null
  }

  /** Start a command on a node (approval is the caller's business). Returns the job, already failed if it couldn't start. */
  async run ({ node, command, cwd, shell, by, chat }) {
    const job = new Job({ id: `j${crypto.randomBytes(5).toString('hex')}`, node, command, cwd, shell, by, chat })
    this.jobs.set(job.id, job)
    while (this.jobs.size > JOBS) {
      const oldest = [...this.jobs.values()].find(item => item.done)
      if (!oldest) break
      this.jobs.delete(oldest.id)
    }
    this.log('job_started', { job: job.id, node: node.name, by, command: command.slice(0, 200) })
    try {
      await this.call(node.id, 'exec', { job: job.id, command, cwd: cwd || undefined, shell: shell || undefined })
      if (job.status === 'starting') job.status = 'running'
    } catch (error) {
      job.finish('failed', { error: error.message })
    }
    this.onJob(job, job.done ? 'exit' : 'start')
    return job
  }

  job (id) { return this.jobs.get(id) ?? null }
  jobList ({ node, running } = {}) {
    return [...this.jobs.values()].filter(job => (!node || job.node === node) && (!running || !job.done)).reverse()
  }

  async cancel (id) {
    const job = this.jobs.get(id)
    if (!job || job.done) return job
    try { await this.call(job.node, 'cancel', { job: id }) } catch (error) { job.finish('cancelled', { error: error.message }) }
    return job
  }

  update (id, { name, policy }) {
    if (name != null) {
      const problem = checkNodeName(name)
      if (problem) return { error: problem }
      const other = this.store.nodeByName(name.trim())
      if (other && other.id !== id) return { error: `A computer is already called ${name.trim()}.` }
    }
    if (policy != null && !['ask', 'always', 'never'].includes(policy)) return { error: 'The policy is ask, always or never.' }
    const node = this.store.updateNode(id, { name: name?.trim(), policy })
    this.onChange()
    return { node }
  }

  remove (id) {
    const node = this.store.node(id)
    if (!node) return false
    this.store.removeNode(id)
    this.links.get(id)?.ws.close(4403, 'removed from the hub')
    this.links.delete(id)
    this.log('node_removed', { name: node.name })
    this.onChange()
    return true
  }

  close () {
    for (const link of this.links.values()) link.ws.close(1001, 'the hub is stopping')
    this.links.clear()
  }
}

/** What a node says about itself, kept to plain values of bounded size. */
function clean (info) {
  if (!info || typeof info !== 'object') return {}
  const text = JSON.stringify(info)
  return text.length > 20000 ? {} : JSON.parse(text)
}
