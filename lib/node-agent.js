// A node: this computer joined to a hub. It connects out to the hub (no port opened here), says what it is (system,
// processors, memory, GPUs, which tools it has), and runs the commands the hub sends, within this computer's own
// policy. The policy is kept here, in this computer's node.json, and the hub cannot change it, so a hub that is ever
// taken over still gets only what this computer allows:
//
//   policy.exec   'any' (the default: whatever the hub's owner approved), 'allowlist' (only commands matching one of
//                 policy.allow, regular expressions), or 'never' (this computer only reports what it is)
//   policy.cwd    the folder commands start in when none is given (your home folder)
//   policy.files  which of this computer's files the hub may take: 'any' (the default when exec is any), 'folders'
//                 (only those in policy.folders, and the inbox: the default otherwise) or 'never' (none, and it
//                 receives none either)
//   policy.inbox  where files the hub sends are put (~/.dsh-hub/inbox); a name already there gets " (2)" and so on
//   policy.bots   whether the hub may add bots to live here: 'any' (the default) or 'own' (only the bots in this
//                 computer's own config); and policy.tasks: whether hub bots may hand this computer tasks ('any', 'never')
//
// Agents (only when DSH runs this node: its plugin gives a `brain`, node-brain.js): bots that live here and tasks
// the hub hands over, each a DSH agent on this computer, with this computer's own model account, tools and approvals.
// The hub sends `agent`; this streams the run back, and asks the hub for approval cards and for posting files.
//
// A job keeps running if the connection drops; its output is kept (the last 64 KB) and the hub hears how it went
// when it is back. Finished jobs are forgotten after an hour. Moving a file is a job too: a download from the hub
// picks up where it stopped when the connection breaks, and both sides check the SHA-256.
import { execFile, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import WebSocket from 'ws'
import { PROTOCOL, hashFile, megabytes } from './nodes.js'

const run = promisify(execFile)
const KEEP = 64 * 1024
const FLUSH_MS = 150
const FLUSH_BYTES = 16 * 1024
const FORGET_MS = 3600 * 1000
const TOOLS = ['ffmpeg', 'video2x', 'python', 'python3', 'node', 'git', 'docker', 'nvidia-smi', 'pwsh', 'bash']
const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

const home = () => process.env.DSH_HUB_HOME || path.join(os.homedir(), '.dsh-hub')
export function defaultConfigPath () { return path.join(home(), 'node.json') }
export function defaultInbox () { return path.join(home(), 'inbox') }
const RETRIES = 5
const PROGRESS_MS = 2000

export function readConfig (file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

/** Keep the node's config readable by this account only: it holds the node's secret. */
export function writeConfig (file, config) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  try { fs.chmodSync(file, 0o600) } catch { /* Windows: the file is in the user's own profile */ }
}

/** The hub's address as an http(s) URL without a trailing slash. */
export function hubUrl (text) {
  const url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `http://${text}`)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('The hub is an http:// or https:// address.')
  return url.origin + url.pathname.replace(/\/+$/, '')
}

/** Join a hub with a pairing code the owner got from it. Returns the config to keep (with the secret). */
export async function enroll ({ hub, code, info, fetch: fetcher = fetch }) {
  const base = hubUrl(hub)
  const response = await fetcher(`${base}/api/nodes/enroll`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, info: info ?? await describe() }),
  })
  const answer = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(answer.error || `The hub said ${response.status}.`)
  return { hub: base, id: answer.id, secret: answer.secret, name: answer.name, policy: { exec: 'any' } }
}

async function quiet (file, args, timeout = 5000) {
  try { return (await run(file, args, { timeout, windowsHide: true })).stdout.trim() } catch { return '' }
}

async function gpus () {
  const nvidia = await quiet('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'])
  if (nvidia) {
    return nvidia.split(/\r?\n/).map(line => line.split(',').map(part => part.trim()))
      .map(([name, memory, driver]) => ({ name, memoryMB: Number(memory) || undefined, driver, vendor: 'nvidia' }))
  }
  if (process.platform === 'win32') {
    const names = await quiet('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }'])
    return names.split(/\r?\n/).filter(Boolean).map(name => ({ name: name.trim() }))
  }
  if (process.platform === 'darwin') {
    const text = await quiet('system_profiler', ['SPDisplaysDataType'], 10000)
    return [...text.matchAll(/Chipset Model: (.+)/g)].map(match => ({ name: match[1].trim() }))
  }
  const text = await quiet('lspci', [])
  return text.split(/\r?\n/).filter(line => /VGA|3D controller/i.test(line)).map(line => ({ name: line.replace(/^.*?: /, '') }))
}

async function tools (names) {
  const finder = process.platform === 'win32' ? 'where.exe' : 'which'
  const found = {}
  await Promise.all(names.map(async name => {
    const where = await quiet(finder, [name], 3000)
    if (where) found[name] = where.split(/\r?\n/)[0]
  }))
  return found
}

/** What this computer is, for the hub and its agent to choose by. */
export async function describe (extraTools = []) {
  const cpus = os.cpus()
  return {
    hostname: os.hostname(), platform: process.platform, release: os.release(), arch: process.arch,
    os: typeof os.version === 'function' ? os.version() : '',
    cpu: cpus[0]?.model?.trim() || '', cores: cpus.length,
    memoryGB: Math.round(os.totalmem() / 2 ** 30 * 10) / 10, freeGB: Math.round(os.freemem() / 2 ** 30 * 10) / 10,
    gpus: await gpus(), tools: await tools([...new Set([...TOOLS, ...extraTools])]),
    user: os.userInfo().username, home: os.homedir(),
    shell: process.platform === 'win32' ? 'powershell' : 'bash', agent: `dsh-hub ${VERSION}`, node: process.version,
  }
}

/** How a command runs in a shell: [program, args, options]. */
export function shellCommand (command, shell) {
  const which = shell || (process.platform === 'win32' ? 'powershell' : 'bash')
  if (which === 'powershell' || which === 'pwsh') {
    const utf8 = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; '
    return [which === 'pwsh' ? 'pwsh' : 'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', utf8 + command], {}]
  }
  if (which === 'cmd') return ['cmd.exe', ['/d', '/s', '/c', `"${command}"`], { windowsVerbatimArguments: true }]
  if (which === 'bash') return ['bash', ['-lc', command], {}]
  if (which === 'sh') return ['/bin/sh', ['-c', command], {}]
  throw new Error(`unknown shell ${which}: use powershell, pwsh, cmd, bash or sh`)
}

/** Why this computer's own policy refuses a command, or ''. */
export function refusal (policy = {}, command) {
  const exec = policy.exec ?? 'any'
  if (exec === 'never') return 'this computer does not run commands from the hub (its policy is never)'
  if (exec === 'allowlist') {
    const allowed = (policy.allow || []).some(pattern => { try { return new RegExp(pattern).test(command) } catch { return false } })
    return allowed ? '' : "this computer's allow list does not allow that command"
  }
  if (exec !== 'any') return `this computer's policy (${exec}) is not one it knows`
  return ''
}

const expand = (where, base) => path.resolve(base, String(where).replace(/^~(?=$|[\\/])/, os.homedir()))
const inside = (where, folder) => {
  const relative = path.relative(path.resolve(folder), where)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** Why this computer's own policy refuses to let the hub take (or, with `where` null, send it) a file, or ''. */
export function fileRefusal (policy = {}, where, inbox) {
  const files = policy.files ?? ((policy.exec ?? 'any') === 'any' ? 'any' : 'folders')
  if (files === 'never') return 'this computer does not swap files with the hub (its file policy is never)'
  if (where == null || files === 'any') return ''
  if (files !== 'folders') return `this computer's file policy (${files}) is not one it knows`
  const allowed = [inbox, ...(policy.folders || [])].some(folder => {
    // compare real paths, so a link inside an allowed folder can't point out of it
    let real = where
    try { real = fs.realpathSync(where) } catch { /* checked as given */ }
    let base = folder
    try { base = fs.realpathSync(folder) } catch { /* not there */ }
    return inside(real, base) || inside(where, folder)
  })
  return allowed ? '' : "that file is not in a folder this computer's file policy lets the hub take from"
}

/** A free name for `name` in `folder`: "video.mp4", else "video (2).mp4"… */
export function freeName (folder, name) {
  const clean = path.basename(String(name).replace(/\\/g, '/')).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').replace(/^\.+/, '') || 'file'
  const { name: stem, ext } = path.parse(clean)
  for (let count = 1; ; count++) {
    const candidate = path.join(folder, count === 1 ? clean : `${stem} (${count})${ext}`)
    if (!fs.existsSync(candidate) && !fs.existsSync(candidate + '.part')) return candidate
  }
}

/** Progress lines for a file job, at most every two seconds. */
function progress (job, total, verb) {
  let last = 0
  const started = Date.now()
  return (done, final = false) => {
    const at = Date.now()
    if (!final && at - last < PROGRESS_MS) return
    last = at
    const rate = done / Math.max(0.5, (at - started) / 1000)
    const share = total ? ` (${Math.floor(done / total * 100)}%)` : ''
    job.say(`${verb} ${megabytes(done)}${total ? ` of ${megabytes(total)}` : ''}${share} · ${megabytes(rate)}/s\n`)
  }
}

function killTree (child) {
  if (!child.pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {})
  } else {
    try { process.kill(-child.pid, 'SIGTERM') } catch { try { child.kill('SIGTERM') } catch { /* gone */ } }
    setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ } }, 5000).unref()
  }
}

export class NodeAgent {
  constructor ({ config, log = () => {}, inbox, connect = (url, options) => new WebSocket(url, options) }) {
    if (!config?.hub || !config?.id || !config?.secret) throw new Error('This computer has not joined a hub yet.')
    this.config = config
    this.log = log
    this.connect = connect
    this.jobs = new Map()
    this.retry = 0
    this.stopped = false
    this.ws = null
    this.inboxFolder = inbox
    this.brain = null
    this.runs = new Map() // run id -> AbortController
    this.requests = new Map() // request id -> { resolve, reject }
  }

  /** DSH's agents for this computer (or null): its bots and tasks. The hub hears of the change. */
  setBrain (brain) {
    this.brain = brain
    this.#hello().catch(() => {})
  }

  async #hello () {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    this.#send({ t: 'hello', info: await this.#info(), jobs: this.#report() })
  }

  async #info () {
    return { ...await describe(this.config.tools), inbox: this.inbox, agents: Boolean(this.brain), bots: this.brain?.bots() ?? [] }
  }

  start () { this.stopped = false; this.#open() }

  stop () {
    this.stopped = true
    clearTimeout(this.timer)
    this.ws?.close(1000)
  }

  #open () {
    const url = this.config.hub.replace(/^http/, 'ws') + '/node'
    const ws = this.connect(url, {
      headers: { Authorization: `Bearer ${this.config.id}.${this.config.secret}`, 'X-Dsh-Hub-Protocol': String(PROTOCOL) },
      handshakeTimeout: 15000, maxPayload: 4 * 1024 * 1024,
    })
    this.ws = ws
    ws.on('open', async () => {
      this.retry = 0
      this.log('connected', { hub: this.config.hub })
      ws.send(JSON.stringify({ t: 'hello', info: await this.#info(), jobs: this.#report() }))
    })
    ws.on('message', data => {
      let message
      try { message = JSON.parse(String(data)) } catch { return }
      if (message.t === 'call') this.#call(message)
      else if (message.t === 'reply') {
        const request = this.requests.get(message.id)
        if (!request) return
        this.requests.delete(message.id)
        if (message.ok) request.resolve(message.value)
        else request.reject(new Error(String(message.error || 'the hub refused')))
      }
    })
    ws.on('unexpected-response', (request, response) => {
      this.log('refused', { status: response.statusCode })
      if (response.statusCode === 401 || response.statusCode === 403) {
        this.log('not_joined', { hint: 'The hub no longer knows this computer. Join it again with a new pairing code.' })
      }
    })
    ws.on('error', error => this.log('connection_error', { error: error.message }))
    ws.on('close', code => {
      if (this.ws !== ws) return
      this.ws = null
      // a run streams to the hub: without it there is nobody to answer, so it stops
      for (const controller of this.runs.values()) controller.abort()
      for (const request of this.requests.values()) request.reject(new Error('the hub is gone'))
      this.requests.clear()
      if (this.stopped) return
      if (code === 4403) { this.log('removed', { hint: 'This computer was removed from the hub.' }); return }
      const delay = Math.min(30000, 1000 * 2 ** this.retry++) * (0.75 + Math.random() / 2)
      this.timer = setTimeout(() => this.#open(), delay)
    })
  }

  #send (message) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message))
  }

  async #call ({ id, op, args = {} }) {
    try {
      const value = await this.#do(op, args)
      this.#send({ t: 'result', id, ok: true, value })
    } catch (error) {
      this.#send({ t: 'result', id, ok: false, error: error.message })
    }
  }

  /** Ask the hub something on behalf of a run. */
  #request (run, op, args, seconds = 3600) {
    if (this.ws?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('the hub is gone'))
    const id = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(id); reject(new Error('the hub did not answer')) }, seconds * 1000)
      this.requests.set(id, { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
      this.#send({ t: 'request', id, run, op, args })
    })
  }

  async #do (op, args) {
    if (op === 'info') return this.#info()
    if (op === 'jobs') return this.#report()
    if (op === 'agent') return this.#agent(args)
    if (op === 'bot.create') {
      if (!this.brain) throw new Error('this computer runs no DSH, so no bot can live here')
      if ((this.config.policy?.bots ?? 'any') !== 'any') throw new Error("this computer's policy keeps its bots to its own config")
      const bot = await this.brain.create(args)
      this.#send({ t: 'bots', bots: this.brain.bots() })
      return bot
    }
    if (op === 'bot.update') {
      if (!this.brain?.update) throw new Error('this computer runs no DSH')
      if ((this.config.policy?.bots ?? 'any') !== 'any') throw new Error("this computer's policy keeps its bots to its own config")
      const bot = await this.brain.update(String(args.name || ''), args)
      this.#send({ t: 'bots', bots: this.brain.bots() })
      return bot
    }
    if (op === 'bot.remove') {
      if (!this.brain) throw new Error('this computer runs no DSH')
      await this.brain.remove(String(args.name || ''))
      this.#send({ t: 'bots', bots: this.brain.bots() })
      return { ok: true }
    }
    if (op === 'cancel' && args.run) { this.runs.get(args.run)?.abort(); return { ok: true } }
    if (op === 'cancel') {
      const job = this.jobs.get(args.job)
      if (job && job.status === 'running') {
        job.cancelled = true
        if (job.child) killTree(job.child)
        job.abort?.abort()
      }
      return { ok: true }
    }
    if (['exec', 'download', 'upload'].includes(op) && !/^j[0-9a-f]{10}$/.test(String(args.job))) throw new Error('bad job id')
    if (op === 'exec') return this.#exec(args)
    if (op === 'download') return this.#download(args)
    if (op === 'upload') return this.#upload(args)
    throw new Error(`unknown operation ${op}`)
  }

  /** A job's record here: its output goes to the hub in batches, its end once. */
  #job (id) {
    if (typeof id !== 'string' || !/^j[0-9a-f]{10}$/.test(id)) throw new Error('bad job id')
    const job = { id, child: null, abort: null, status: 'running', code: null, error: '', cancelled: false, result: null,
      tail: '', buffer: '', ended: 0 }
    const flush = () => {
      clearTimeout(job.flushing)
      job.flushing = null
      if (!job.buffer) return
      this.#send({ t: 'job', job: id, event: 'output', stream: 'stdout', data: job.buffer })
      job.buffer = ''
    }
    job.say = text => {
      job.tail = (job.tail + text).slice(-KEEP)
      job.buffer += text
      if (job.buffer.length >= FLUSH_BYTES) flush()
      else if (!job.flushing) job.flushing = setTimeout(flush, FLUSH_MS)
    }
    job.finish = (code, error = '', result = null) => {
      if (job.status !== 'running') return
      flush()
      Object.assign(job, { status: 'ended', code, error, result, ended: Date.now(), child: null, abort: null })
      this.#send({ t: 'job', job: id, event: 'exit', code, error, cancelled: job.cancelled, result })
      setTimeout(() => this.jobs.delete(id), FORGET_MS).unref()
    }
    this.jobs.set(id, job)
    return job
  }

  #exec ({ job: id, command, cwd, shell }) {
    if (this.jobs.has(id)) return { ok: true } // a call repeated after a reconnect
    if (typeof command !== 'string' || !command.trim()) throw new Error('no command')
    const why = refusal(this.config.policy, command)
    if (why) { this.log('exec_refused', { why, command: command.slice(0, 200) }); throw new Error(why) }
    const folder = cwd || this.config.policy?.cwd || os.homedir()
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error(`no folder ${folder} on this computer`)
    const [program, argv, extra] = shellCommand(command, shell)
    const child = spawn(program, argv, { cwd: folder, windowsHide: true, detached: process.platform !== 'win32', ...extra })
    const job = this.#job(id)
    job.child = child
    this.log('exec', { job: id, command: command.slice(0, 200), cwd: folder })
    const take = chunk => job.say(chunk.toString('utf8'))
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.on('error', error => job.finish(null, error.message))
    child.on('close', (code, signal) => job.finish(code, signal ? `stopped by ${signal}` : ''))
    return { ok: true, pid: child.pid }
  }

  get inbox () { return expand(this.config.policy?.inbox || this.inboxFolder || defaultInbox(), os.homedir()) }
  #auth () { return { Authorization: `Bearer ${this.config.id}.${this.config.secret}` } }

  /** Fetch a file from the hub into the inbox, picking up where it stopped if the connection breaks. */
  #download ({ job: id, ticket, name, size }) {
    if (this.jobs.has(id)) return { ok: true }
    const why = fileRefusal(this.config.policy, null, this.inbox)
    if (why) { this.log('download_refused', { why }); throw new Error(why) }
    fs.mkdirSync(this.inbox, { recursive: true })
    const target = freeName(this.inbox, name)
    const part = target + '.part'
    fs.writeFileSync(part, '', { flag: 'wx' }) // claim the name now
    const job = this.#job(id)
    job.abort = new AbortController()
    const total = Number(size) || 0
    const report = progress(job, total, 'received')
    this.log('download', { job: id, name, to: target })
    const url = `${this.config.hub}/api/nodes/download?ticket=${encodeURIComponent(ticket)}`
    ;(async () => {
      let tries = 0
      while (true) {
        const have = fs.statSync(part).size
        if (total && have >= total) break
        try {
          const response = await fetch(url, { headers: { ...this.#auth(), ...(have ? { Range: `bytes=${have}-` } : {}) }, signal: job.abort.signal })
          if (!response.ok) {
            const answer = await response.json().catch(() => ({}))
            const error = new Error(answer.error || `the hub said ${response.status}`)
            error.final = response.status < 500
            throw error
          }
          if (have && response.status !== 206) fs.truncateSync(part, 0) // the hub sent it all again
          let done = response.status === 206 ? have : 0
          const counter = async function * (source) {
            for await (const chunk of source) { done += chunk.length; report(done); yield chunk }
          }
          await pipeline(Readable.fromWeb(response.body), counter, fs.createWriteStream(part, { flags: 'a' }))
          report(done, true)
          break
        } catch (error) {
          if (job.cancelled || error.final || ++tries > RETRIES) throw error
          job.say(`connection lost (${error.message}); trying again…\n`)
          await new Promise(resolve => setTimeout(resolve, Math.min(30000, 1000 * 2 ** tries)))
        }
      }
      const got = fs.statSync(part).size
      if (total && got !== total) throw new Error(`got ${got} bytes, not ${total}`)
      fs.renameSync(part, target)
      const sha256 = await hashFile(target)
      job.say(`saved as ${target}\n`)
      return { path: target, size: got, sha256 }
    })().then(
      result => job.finish(0, '', result),
      error => {
        fs.rmSync(part, { force: true })
        job.finish(null, job.cancelled ? 'stopped' : error.message)
      })
    return { ok: true, path: target }
  }

  /** Send one of this computer's files to the hub, if this computer's file policy allows it. */
  #upload ({ job: id, ticket, path: given, limit }) {
    if (this.jobs.has(id)) return { ok: true }
    if (typeof given !== 'string' || !given.trim()) throw new Error('no file given')
    const where = expand(given.trim(), this.config.policy?.cwd || os.homedir())
    const why = fileRefusal(this.config.policy, where, this.inbox)
    if (why) { this.log('upload_refused', { why, path: where }); throw new Error(why) }
    let stat
    try { stat = fs.statSync(where) } catch { throw new Error(`there is no file ${where} on this computer`) }
    if (!stat.isFile()) throw new Error(`${where} is a folder, not a file: zip it first`)
    if (limit && stat.size > limit) throw new Error(`${where} is ${megabytes(stat.size)}; the hub takes at most ${megabytes(limit)}`)
    const job = this.#job(id)
    job.abort = new AbortController()
    const report = progress(job, stat.size, 'sent')
    this.log('upload', { job: id, path: where })
    this.#send_file(where, ticket, { limit, signal: job.abort.signal, report }).then(
      sent => job.finish(0, '', { path: where, name: path.basename(where), size: sent.size, sha256: sent.sha256, file: sent.file?.id }),
      error => job.finish(null, job.cancelled ? 'stopped' : error.message))
    return { ok: true }
  }

  /** A run of an agent here: a bot's reply, or a task. Streams back as { t: 'run' } messages. */
  #agent ({ run: id, mode, bot, session, text }) {
    if (!this.brain) throw new Error('this computer runs no DSH, so it has no agents')
    if (typeof id !== 'string' || !/^[rj][0-9a-f]{10}$/.test(id)) throw new Error('bad run id')
    if (this.runs.has(id)) return { ok: true }
    if (mode === 'task' && (this.config.policy?.tasks ?? 'any') === 'never') throw new Error("this computer's policy takes no tasks from the hub")
    if (mode === 'reply' && !this.brain.bots().some(item => item.name === bot)) throw new Error(`no bot ${bot} lives here`)
    const controller = new AbortController()
    this.runs.set(id, controller)
    let streamed = 0
    let pending = null
    const sink = {
      stream: said => {
        pending = said
        const at = Date.now()
        if (at - streamed < 100) return
        streamed = at
        this.#send({ t: 'run', run: id, event: 'stream', text: pending })
        pending = null
      },
      activity: line => this.#send({ t: 'run', run: id, event: 'activity', line: String(line).slice(0, 200) }),
    }
    const approve = async ({ tool, summary, detail }) => {
      try { return (await this.#request(id, 'ask', { tool, summary, detail })).decision } catch { return 'cancelled' }
    }
    const postFile = async given => {
      const where = expand(String(given), this.config.policy?.cwd || os.homedir())
      const why = fileRefusal(this.config.policy, where, this.inbox)
      if (why) throw new Error(why)
      const { ticket, limit } = await this.#request(id, 'post_file', { name: path.basename(where) })
      return this.#send_file(where, ticket, { limit, signal: controller.signal })
    }
    this.log('agent', { run: id, mode, bot })
    this.brain.run({ mode, bot, session, text, sink, signal: controller.signal, approve, postFile }).then(
      result => this.#send({ t: 'run', run: id, event: 'end', text: result.text, session: result.session }),
      error => this.#send({ t: 'run', run: id, event: 'end', error: controller.signal.aborted ? 'stopped' : String(error?.message || error) }),
    ).finally(() => this.runs.delete(id))
    return { ok: true }
  }

  /** Send a file to the hub with a ticket. Resolves { file, size, sha256 } once the hub has the same bytes. */
  async #send_file (where, ticket, { limit, signal, report = () => {} } = {}) {
    let stat
    try { stat = fs.statSync(where) } catch { throw new Error(`there is no file ${where} on this computer`) }
    if (!stat.isFile()) throw new Error(`${where} is a folder, not a file: zip it first`)
    if (limit && stat.size > limit) throw new Error(`${where} is ${megabytes(stat.size)}; the hub takes at most ${megabytes(limit)}`)
    const name = path.basename(where)
    const url = `${this.config.hub}/api/nodes/upload?ticket=${encodeURIComponent(ticket)}&name=${encodeURIComponent(name)}`
    const hash = crypto.createHash('sha256')
    let done = 0
    const source = fs.createReadStream(where)
    const counted = Readable.from((async function * () {
      for await (const chunk of source) { hash.update(chunk); done += chunk.length; report(done); yield chunk }
    })())
    const response = await fetch(url, {
      method: 'POST', body: counted, duplex: 'half', signal,
      headers: { ...this.#auth(), 'Content-Type': 'application/octet-stream' },
    })
    const answer = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(answer.error || `the hub said ${response.status}`)
    report(done, true)
    const sha256 = hash.digest('hex')
    if (answer.sha256 !== sha256) throw new Error("the hub's copy differs from this computer's (SHA-256)")
    return { file: answer.file, size: done, sha256, path: where }
  }

  #report () {
    return [...this.jobs.values()].map(job => ({ job: job.id, status: job.status, code: job.code, error: job.error,
      cancelled: job.cancelled, tail: job.tail, result: job.result }))
  }
}
