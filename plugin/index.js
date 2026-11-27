// DeepSeek Harness plugin: this DSH as the hub of your computers (role: hub), as one of them (role: node), or neither
// (off) until you choose.
//
// Choose on DSH's Plugins page (Plugins → dsh-hub, in the desktop app or DSH's web page; client.js), or on the command
// line with `dsh-hub config` (bin/dsh-hub.js). Both write <DSH home>/dsh-hub/settings.json (lib/settings.js), and a
// running DSH follows a change within seconds. A fresh install is off; a computer that already has a hub stays one.
//
// A profile's cordis.patch.yml may set any of it too, and then wins (the page shows those settings as locked):
//
// Hub (the main DSH): starts the hub's server (the chat page, accounts, nodes; lib/start.js) with DSH's agents as its
// brain (brain.js).
//
//   - id: dsh-hub
//     config:
//       role: hub
//       port: 4180               # the page and the nodes' door
//       host: 0.0.0.0
//       access: lan              # lan (home network and Tailscale) or anywhere (still behind accounts)
//       hostnames: []            # names of yours the hub is opened by
//       trustProxy: []           # reverse proxies whose X-Forwarded-* to believe
//       tls: { cert: <file>, key: <file> }
//       title: Hub
//       maxUploadMB: 2048
//       folder: <DSH home>/dsh-hub  # where the hub keeps its accounts, chats and files (and settings.json)
//       bots:                    # bots of the config's (locked on the page); others are made on the hub's page
//         - { name: deepseek, display: DeepSeek, description: ..., prompt: ..., model: { provider, model } }
//       model: { provider: ..., model: ... }   # default: DSH's default model
//       permission: workspace-write
//
// Node (every other computer): joins the hub once with a pairing code from its page, then stays connected.
//
//   - id: dsh-hub
//     config:
//       role: node
//       hub: http://192.168.1.10:4180
//       code: ABCD-EFGH          # only the first time; the node keeps its secret in <DSH home>/dsh-hub/node.json
//       policy:                  # this computer's own last word; the hub can't change it
//         exec: any              # any, allowlist (with allow: [patterns]) or never
//         files: any             # which files the hub may take: any, folders (with folders: [paths]) or never
//         inbox: ~/Videos/hub    # where files from the hub go (default <DSH home>/dsh-hub/inbox)
//         bots: any              # any: the hub's owner may add bots to live here; own: only the bots below
//         tasks: any             # any: hub bots may hand this computer tasks (computer_delegate); never
//       bots:                    # bots that live here, besides those added from the hub's page
//         - { display: ROG, description: The gaming PC, prompt: ... }
//       permission: workspace-write   # the DSH permission preset its agents run under (approvals go to the hub)
//       workspace: <inbox>       # the folder its agents work in
//
// With DSH, a node also has agents: the bots living here and the agent for tasks from the hub, using this computer's
// own model account (node-brain.js). `dsh-hub node` without DSH only runs commands and moves files.
import fs from 'node:fs'
import path from 'node:path'
import { NodeAgent, enroll, readConfig, writeConfig } from '../lib/node-agent.js'
import { dshHome, settingsFile } from '../lib/settings.js'
import { consoleLog, startHub } from '../lib/start.js'
import { computerTools } from '../lib/tools.js'
import { dshBrain } from './brain.js'
import { control, serve } from './control.js'
import { nodeBrain } from './node-brain.js'

export const name = 'dsh-hub'
export const inject = []

const HUB_SERVICES = ['agents', 'agentPresets', 'tools', 'approval', 'sessionQuery', 'agentDefaultModel', 'llm']
const NODE_SERVICES = ['agents', 'agentPresets', 'approval', 'sessionQuery', 'agentDefaultModel']

async function home () {
  try {
    const { resolveDshHome } = await import('@deepseek-ai/dsh-home-paths')
    return path.join(resolveDshHome(), 'dsh-hub')
  } catch {
    return process.env.DSH_HUB_HOME || path.join(dshHome(), 'dsh-hub')
  }
}

function logger (ctx, prefix) {
  const fallback = consoleLog(prefix)
  return (event, fields) => {
    try {
      const logger = ctx.logger?.('dsh-hub')
      if (logger?.info) { logger.info(`${event} ${JSON.stringify(fields ?? {})}`); return }
    } catch { /* no logger service */ }
    fallback(event, fields)
  }
}

export function apply (ctx, profile = {}) {
  profile = profile ?? {}
  const log = logger(ctx, 'dsh-hub')
  // DSH may unload this instance before it has finished starting (it reloads a plugin whose config it rewrites): from
  // then on, this instance starts nothing and leaves the file to the next one
  let disposed = false
  let unwatch = () => {}
  const ready = (async () => {
    const folder = profile.folder ? path.resolve(profile.folder) : await home()
    if (disposed) return null
    const work = control({
      folder, profile, log,
      start: async (role, config, live) => {
        if (role === 'off' || disposed) return null
        // the role as a plugin of its own, so a change of settings unloads it whole (its agents, presets, server)
        const fiber = ctx.plugin({
          name: `dsh-hub-${role}`,
          // (returns nothing: Cordis takes what apply returns for an effect)
          apply: child => {
            if (role === 'hub') child.inject(HUB_SERVICES, scope => hub(scope, config, folder, live))
            else node(child, config, folder, live)
          },
        })
        // a role that fails to load says so on the page
        Promise.resolve(fiber).catch(error => {
          live.error = String(error?.message ?? error)
          log('start_failed', { role, error: String(error?.stack ?? error) })
        })
        return () => fiber.dispose()
      },
    })
    // `dsh-hub config` writes the file while this runs (this instance's own listener: the next one has its own)
    const file = settingsFile(folder)
    const changed = () => { if (!disposed) work.refresh().catch(() => {}) }
    fs.watchFile(file, { interval: 1500 }, changed)
    unwatch = () => fs.unwatchFile(file, changed)
    await work.refresh()
    return work
  })()
  ready.catch(error => log('start_failed', { error: String(error?.stack || error) }))
  ctx.effect(() => () => {
    disposed = true
    unwatch()
    return ready.then(work => work?.close()).catch(() => {})
  })
  // the settings page's routes, where DSH serves a page (the desktop app, the web profile)
  ctx.inject(['connection'], scope => serve(scope.connection, async () => {
    const work = await ready
    if (!work) throw new Error('dsh-hub is restarting; try again in a moment')
    return work
  }))
}

function hub (ctx, config, folder, live) {
  const log = logger(ctx, 'dsh-hub')
  let running = null
  let closed = false
  const started = (async () => {
    const brain = await dshBrain(ctx, {
      title: config.title ?? 'Hub', model: config.model, permission: config.permission ?? 'workspace-write',
      workspace: config.workspace ?? path.join(folder, 'workspace'), log,
      toolDefinitions: computerTools(null).map(({ name, description, parameters }) => ({ name, description, parameters })),
    })
    let hubRunning
    try {
      hubRunning = await startHub({
        folder: path.join(folder, 'hub'), host: config.host, port: config.port, access: config.access,
        hostnames: config.hostnames, trustProxy: config.trustProxy, tls: config.tls, title: config.title,
        maxUploadMB: config.maxUploadMB, bots: config.bots, brain, log,
      })
    } catch (error) {
      await brain.close?.()
      throw error
    }
    if (closed) await hubRunning.close()
    else { running = hubRunning; live.hub = hubRunning }
  })()
  started.catch(error => {
    live.error = error?.code === 'EADDRINUSE' ? `port ${config.port ?? 4180} is in use: pick another one` : String(error?.message || error)
    log('start_failed', { error: String(error?.stack || error) })
  })
  ctx.effect(() => () => {
    closed = true
    live.hub = null
    return started.catch(() => {}).then(() => running?.close())
  })
}

function node (ctx, config, folder, live) {
  const base = logger(ctx, 'dsh-hub node')
  const log = (event, fields = {}) => {
    if (event === 'connected') live.problem = null
    if (['not_joined', 'removed'].includes(event)) live.problem = fields.hint
    if (event === 'refused' && !live.problem) live.problem = `the hub refused this computer (${fields.status})`
    if (event === 'connection_error') live.problem = `can't reach the hub: ${fields.error}`
    base(event, fields)
  }
  let agent = null
  let closed = false
  const started = (async () => {
    const file = path.join(folder, 'node.json')
    let kept = readConfig(file)
    if (!kept?.secret || (config.hub && kept.hub && new URL(config.hub).origin !== new URL(kept.hub).origin)) {
      if (!config.hub || !config.code) {
        log('not_joined', { hint: 'Not joined to a hub yet: enter its address and a pairing code from its page (Settings, Computers, Add).' })
        return
      }
      kept = await enroll({ hub: config.hub, code: config.code })
      log('joined', { hub: kept.hub, name: kept.name })
    }
    if (config.policy) kept.policy = { ...kept.policy, ...config.policy }
    if (config.tools) kept.tools = config.tools
    writeConfig(file, kept)
    if (closed) return
    agent = new NodeAgent({ config: kept, log, inbox: path.join(folder, 'inbox') })
    live.agent = agent
    agent.start()
    return { agent, folder }
  })()
  started.catch(error => {
    live.error = String(error?.message || error)
    log('start_failed', { error: String(error?.message || error) })
  })
  ctx.effect(() => () => {
    closed = true
    live.agent = null
    agent?.stop()
  })
  // DSH's agents, when this DSH has them: the bots living here and tasks from the hub
  ctx.inject(NODE_SERVICES, scope => {
    let brain = null
    let gone = false
    started.then(async running => {
      if (!running || gone) return
      brain = await nodeBrain(scope, {
        folder: running.folder, inbox: running.agent.inbox, bots: config.bots, workspace: config.workspace,
        permission: config.permission ?? 'workspace-write', model: config.model, log,
      })
      if (gone) { await brain.close(); return }
      running.agent.setBrain(brain)
      log('agents_ready', { bots: brain.bots().map(bot => bot.display) })
    }).catch(error => log('agents_failed', { error: String(error?.stack || error) }))
    scope.effect(() => () => {
      gone = true
      started.then(running => running?.agent.setBrain(null)).catch(() => {})
      return brain?.close().catch(() => {})
    })
  })
}
