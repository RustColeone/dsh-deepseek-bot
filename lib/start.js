// Putting a hub together: its data folder, accounts, nodes, chats and server, with whatever brain thinks for it.
// Used by the DSH plugin (plugin/index.js, with DSH's agents as the brain) and by `dsh-hub hub` (the echo brain).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Accounts } from './auth.js'
import { Guard } from './guard.js'
import { Hub } from './hub.js'
import { Nodes } from './nodes.js'
import { createServer } from './server.js'
import { Store } from './store.js'

export const DEFAULT_PORT = 4180

export function defaultFolder () {
  return path.join(process.env.DSH_HUB_HOME || path.join(os.homedir(), '.dsh-hub'), 'hub')
}

export function consoleLog (prefix = 'dsh-hub') {
  return (event, fields = {}) => {
    const parts = Object.entries(fields).map(([key, value]) => `${key}=${typeof value === 'string' && !/\s/.test(value) ? value : JSON.stringify(value)}`)
    console.log(`[${prefix}] ${event}${parts.length ? ' ' + parts.join(' ') : ''}`)
  }
}

/** `work`, or `milliseconds` gone by, whichever is first (a failure counts as done). */
function within (work, milliseconds) {
  if (!work) return Promise.resolve()
  let timer
  return Promise.race([
    Promise.resolve(work).catch(() => {}),
    new Promise(resolve => { timer = setTimeout(resolve, milliseconds); timer.unref() }),
  ]).finally(() => clearTimeout(timer))
}

/** The addresses other devices on the network can open the hub at. */
export function addresses (host, port, scheme) {
  if (host !== '0.0.0.0' && host !== '::') return [`${scheme}://${host.includes(':') ? `[${host}]` : host}:${port}/`]
  const found = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.internal || item.family !== 'IPv4') continue
      found.push(`${scheme}://${item.address}:${port}/`)
    }
  }
  return [`${scheme}://localhost:${port}/`, ...found]
}

/**
 * Start a hub. Options: folder, host ('0.0.0.0'), port (4180), access ('lan' | 'anywhere'), hostnames, trustProxy, bots (the config's),
 * tls ({ cert, key } file paths), title, maxUploadMB, brain, log. Resolves { hub, server, urls, close }.
 */
export async function startHub (options = {}) {
  const log = options.log ?? consoleLog()
  const folder = options.folder ?? defaultFolder()
  const host = options.host ?? '0.0.0.0'
  const port = options.port ?? DEFAULT_PORT
  const access = options.access ?? 'lan'
  if (!['lan', 'anywhere'].includes(access)) throw new Error("access is 'lan' or 'anywhere'")
  const tls = options.tls?.cert && options.tls?.key
    ? { cert: fs.readFileSync(options.tls.cert), key: fs.readFileSync(options.tls.key) } : null
  const store = new Store(folder)
  const accounts = new Accounts(store, { log })
  let hub = null
  const nodes = new Nodes(store, { log, onChange: () => hub?.nodesChanged(), onJob: job => hub?.jobChanged(job) })
  hub = new Hub({ store, nodes, brain: options.brain, bots: options.bots ?? [], title: options.title ?? 'Hub', maxUploadMB: options.maxUploadMB ?? 2048, log })
  const guard = new Guard({ access, hostnames: options.hostnames ?? [], trustProxy: options.trustProxy ?? [], tls: Boolean(tls), log })
  const server = createServer({ hub, accounts, nodes, guard, tls, log, title: hub.title })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => { server.off('error', reject); resolve() })
  })
  const actual = server.address().port
  const urls = addresses(host, actual, tls ? 'https' : 'http')
  log('listening', { urls: urls.join(' '), access })
  if (access === 'anywhere' && !tls && !(options.trustProxy ?? []).length) {
    log('warning', { text: 'access is anywhere without https: passwords cross the network readable. Use Tailscale or WireGuard, or give the hub a certificate (tls) or an https proxy (trustProxy).' })
  }
  const codeFile = path.join(folder, 'setup-code.txt')
  if (accounts.empty) {
    const code = accounts.newSetupCode(codeFile)
    console.log(`\n  dsh-hub has no accounts yet. Open ${urls[0]}setup and make the owner's account\n` +
      `  with this setup code (it works once, until the hub restarts):\n\n      ${code}\n\n  It is also in ${codeFile}\n`)
    log('setup_code', { file: codeFile, page: `${urls[0]}setup` })
  } else {
    Accounts.dropCodeFile(codeFile)
  }
  store.dropExpiredLogins()
  const tidy = setInterval(() => store.dropExpiredLogins(), 6 * 3600 * 1000)
  tidy.unref()
  return {
    hub, server, urls, accounts, nodes, store, port: actual,
    /**
     * Stop at once, whoever is connected: DSH's desktop app gives its Host 10 seconds to stop before an update, and
     * refuses the update when it takes longer. Each step has its own deadline, so one that hangs can't hold the rest.
     */
    async close () {
      clearInterval(tidy)
      hub.close()
      nodes.close()
      const closed = new Promise(resolve => server.close(() => resolve()))
      server.closeAllConnections?.() // requests and idle keep-alive connections (not websockets: dropSockets)
      await within(server.dropSockets?.(), 1500)
      await within(closed, 1500)
      await within(options.brain?.close?.(), 3000)
      store.close()
    },
  }
}
