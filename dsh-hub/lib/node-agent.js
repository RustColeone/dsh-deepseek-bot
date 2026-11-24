// A node: this computer joined to a hub. It connects out to the hub (no port opened here), says what it is (system,
// processors, memory, GPUs, which tools it has), and runs the commands the hub sends, within this computer's own
// policy. The policy is kept here, in this computer's node.json, and the hub cannot change it, so a hub that is ever
// taken over still gets only what this computer allows:
//
//   policy.exec   'any' (the default: whatever the hub's owner approved), 'allowlist' (only commands matching one of
//                 policy.allow, regular expressions), or 'never' (this computer only reports what it is)
//   policy.cwd    the folder commands start in when none is given (your home folder)
//
// A job keeps running if the connection drops; its output is kept (the last 64 KB) and the hub hears how it went
// when it is back. Finished jobs are forgotten after an hour.
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import WebSocket from 'ws'
import { PROTOCOL } from './nodes.js'

const run = promisify(execFile)
const KEEP = 64 * 1024
const FLUSH_MS = 150
const FLUSH_BYTES = 16 * 1024
const FORGET_MS = 3600 * 1000
const TOOLS = ['ffmpeg', 'video2x', 'python', 'python3', 'node', 'git', 'docker', 'nvidia-smi', 'pwsh', 'bash']
const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

export function defaultConfigPath () {
  return path.join(process.env.DSH_HUB_HOME || path.join(os.homedir(), '.dsh-hub'), 'node.json')
}

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
  constructor ({ config, log = () => {}, connect = (url, options) => new WebSocket(url, options) }) {
    if (!config?.hub || !config?.id || !config?.secret) throw new Error('This computer has not joined a hub yet.')
    this.config = config
    this.log = log
    this.connect = connect
    this.jobs = new Map()
    this.retry = 0
    this.stopped = false
    this.ws = null
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
      ws.send(JSON.stringify({ t: 'hello', info: await describe(this.config.tools), jobs: this.#report() }))
    })
    ws.on('message', data => {
      let message
      try { message = JSON.parse(String(data)) } catch { return }
      if (message.t === 'call') this.#call(message)
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

  async #do (op, args) {
    if (op === 'info') return describe(this.config.tools)
    if (op === 'jobs') return this.#report()
    if (op === 'cancel') {
      const job = this.jobs.get(args.job)
      if (job && job.status === 'running') { job.cancelled = true; killTree(job.child) }
      return { ok: true }
    }
    if (op === 'exec') return this.#exec(args)
    throw new Error(`unknown operation ${op}`)
  }

  #exec ({ job: id, command, cwd, shell }) {
    if (typeof id !== 'string' || !/^j[0-9a-f]{10}$/.test(id)) throw new Error('bad job id')
    if (this.jobs.has(id)) return { ok: true } // a call repeated after a reconnect
    if (typeof command !== 'string' || !command.trim()) throw new Error('no command')
    const why = refusal(this.config.policy, command)
    if (why) { this.log('exec_refused', { why, command: command.slice(0, 200) }); throw new Error(why) }
    const folder = cwd || this.config.policy?.cwd || os.homedir()
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error(`no folder ${folder} on this computer`)
    const [program, argv, extra] = shellCommand(command, shell)
    const child = spawn(program, argv, { cwd: folder, windowsHide: true, detached: process.platform !== 'win32', ...extra })
    const job = { id, child, status: 'running', code: null, error: '', cancelled: false, tail: '', buffer: '', ended: 0 }
    this.jobs.set(id, job)
    this.log('exec', { job: id, command: command.slice(0, 200), cwd: folder })
    const flush = () => {
      clearTimeout(job.flushing)
      job.flushing = null
      if (!job.buffer) return
      this.#send({ t: 'job', job: id, event: 'output', stream: 'stdout', data: job.buffer })
      job.buffer = ''
    }
    const take = chunk => {
      const text = chunk.toString('utf8')
      job.tail = (job.tail + text).slice(-KEEP)
      job.buffer += text
      if (job.buffer.length >= FLUSH_BYTES) flush()
      else if (!job.flushing) job.flushing = setTimeout(flush, FLUSH_MS)
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    const finish = (code, error = '') => {
      if (job.status !== 'running') return
      flush()
      Object.assign(job, { status: 'ended', code, error, ended: Date.now(), child: null })
      this.#send({ t: 'job', job: id, event: 'exit', code, error, cancelled: job.cancelled })
      setTimeout(() => this.jobs.delete(id), FORGET_MS).unref()
    }
    child.on('error', error => finish(null, error.message))
    child.on('close', (code, signal) => finish(code, signal ? `stopped by ${signal}` : ''))
    return { ok: true, pid: child.pid }
  }

  #report () {
    return [...this.jobs.values()].map(job => ({ job: job.id, status: job.status, code: job.code, error: job.error,
      cancelled: job.cancelled, tail: job.tail }))
  }
}
