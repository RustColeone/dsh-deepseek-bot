// What this computer runs and how it is set, for DSH's Plugins page (the routes below, which plugin/client.js calls)
// and for the settings file `dsh-hub config` writes. A change starts the new role in place of the old one.
import fs from 'node:fs'
import path from 'node:path'
import { enroll, readConfig, writeConfig } from '../lib/node-agent.js'
import { clean, effective, readSettings, settingsFile, writeSettings } from '../lib/settings.js'

const OPEN = 1 // WebSocket.OPEN

/**
 * @param options { folder, profile (this profile's own config), log, start(role, config, live) → stop() | null,
 *   enroll (for tests) }
 * `live` is where a running role leaves what the page shows: { hub (startHub's handle), agent (a NodeAgent),
 * error, problem }.
 */
export function control ({ folder, profile = {}, log = () => {}, start, enroll: join = enroll }) {
  const nodeFile = path.join(folder, 'node.json')
  let running = null // { key, stop, live, role }
  let queue = Promise.resolve()
  let closed = false

  const stamp = file => { try { return fs.statSync(file).mtimeMs } catch { return 0 } }

  /** Start what the settings say, unless it is already running (`force`: again anyway). */
  function refresh (force = false) {
    const next = queue.then(async () => {
      if (closed) return
      const chosen = effective(profile, readSettings(folder), folder)
      const key = JSON.stringify({ role: chosen.role, config: chosen.config, node: chosen.role === 'node' ? stamp(nodeFile) : 0 })
      if (!force && running?.key === key) return
      if (running?.stop) await running.stop()
      const live = { hub: null, agent: null, error: null, problem: null }
      running = { key, live, role: chosen.role, stop: null }
      if (chosen.role === 'off') log('off', { hint: 'Pick a role on DSH\'s Plugins page (dsh-hub), or with dsh-hub config.' })
      try {
        running.stop = await start(chosen.role, chosen.config, live)
      } catch (error) {
        live.error = String(error?.message ?? error)
        log('start_failed', { error: String(error?.stack ?? error) })
      }
    })
    queue = next.catch(() => {})
    return next
  }

  function status () {
    const live = running?.live ?? {}
    if (running?.role === 'hub') {
      const hub = live.hub
      if (!hub) return { running: false, error: live.error, starting: !live.error }
      const computers = hub.nodes.list()
      return {
        running: true, urls: hub.urls, port: hub.port,
        // the setup code is shown to DSH's owner only (the routes are behind DSH's sign-in)
        setupCode: hub.accounts.empty ? hub.accounts.setupCode : null,
        computers: { total: computers.length, online: computers.filter(node => node.online).length },
      }
    }
    if (running?.role === 'node') {
      const kept = readConfig(nodeFile)
      return {
        joined: Boolean(kept?.secret), hub: kept?.hub ?? null, name: kept?.name ?? null,
        connected: live.agent?.ws?.readyState === OPEN, problem: live.problem, error: live.error,
      }
    }
    return {}
  }

  function state () {
    const chosen = effective(profile, readSettings(folder), folder)
    const { code, ...config } = chosen.config
    return { role: chosen.role, settings: chosen.settings, config, locked: chosen.locked, folder, file: settingsFile(folder), status: status() }
  }

  const lockedRole = () => profile?.role !== undefined

  return {
    refresh,
    state,

    /** The page's settings, whole: { role, hub, node }. */
    async save (input) {
      const settings = clean(input)
      if (lockedRole() && settings.role && settings.role !== profile.role) {
        throw new RangeError(`this profile's cordis.patch.yml makes it a ${profile.role}; change it there`)
      }
      writeSettings(folder, settings)
      log('settings_saved', { role: settings.role ?? null })
      await refresh()
      return state()
    },

    /** Join a hub with a pairing code from its page, and run as its node. */
    async join ({ hub, code }) {
      if (lockedRole() && profile.role !== 'node') throw new RangeError(`this profile's cordis.patch.yml makes it a ${profile.role}; change it there`)
      if (!String(code ?? '').trim()) throw new RangeError('the pairing code is on the hub\'s page: Settings, Computers, Add')
      const settings = clean({ ...readSettings(folder), role: 'node' })
      settings.node.hub = clean({ node: { hub } }).node.hub
      if (!settings.node.hub) throw new RangeError('the hub\'s address is like http://192.168.1.10:4180')
      const kept = await join({ hub: settings.node.hub, code: String(code).trim() })
      writeConfig(nodeFile, kept)
      writeSettings(folder, settings)
      log('joined', { hub: kept.hub, name: kept.name })
      await refresh(true)
      return state()
    },

    /** Forget the hub this computer joined (it can join one again with a new code). */
    async forget () {
      try { fs.unlinkSync(nodeFile) } catch { /* not joined */ }
      log('forgot_hub', {})
      await refresh(true)
      return state()
    },

    async close () {
      closed = true
      await queue
      await running?.stop?.()
      running = null
    },
  }
}

const answer = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

/** The page's routes, on DSH's own API (`connection.fetch`: signed in, the owner only). */
export function serve (connection, ready) {
  const route = (where, methods, handle) => connection.fetch.register({
    path: where, methods, requestBody: 'buffered',
    fetch: async request => {
      try {
        const work = await ready()
        let body = {}
        if (request.method === 'POST') { try { body = await request.json() } catch { body = {} } }
        return answer(await handle(work, body))
      } catch (error) {
        return answer({ error: String(error?.message ?? error) }, error instanceof RangeError ? 400 : 502)
      }
    },
  })
  route('/api/dsh-hub.state', ['GET'], work => work.state())
  route('/api/dsh-hub.settings', ['POST'], (work, body) => work.save(body))
  route('/api/dsh-hub.join', ['POST'], (work, body) => work.join(body))
  route('/api/dsh-hub.forget', ['POST'], work => work.forget())
}
