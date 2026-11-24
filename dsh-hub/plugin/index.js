// DeepSeek Harness plugin: this DSH as the hub of your computers (role: hub), or as one of them (role: node).
//
// Hub (the main DSH): starts the hub's server (the chat page, accounts, nodes; lib/start.js) with DSH's agents as its
// brain (brain.js). Settings in the profile's cordis.patch.yml:
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
//       folder: <DSH home>/dsh-hub  # where the hub keeps its accounts, chats and files
//       bots:                    # who talks; default: one, DeepSeek
//         - { name: deepseek, display: DeepSeek, description: ..., prompt: ... }
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
import os from 'node:os'
import path from 'node:path'
import { NodeAgent, enroll, readConfig, writeConfig } from '../lib/node-agent.js'
import { consoleLog, startHub } from '../lib/start.js'
import { computerTools } from '../lib/tools.js'
import { dshBrain } from './brain.js'

export const name = 'dsh-hub'
export const inject = []

const HUB_SERVICES = ['agents', 'agentPresets', 'tools', 'approval', 'sessionQuery', 'agentDefaultModel']

async function home () {
  try {
    const { resolveDshHome } = await import('@deepseek-ai/dsh-home-paths')
    return path.join(resolveDshHome(), 'dsh-hub')
  } catch {
    return process.env.DSH_HUB_HOME || path.join(os.homedir(), '.dsh-hub')
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

export function apply (ctx, config = {}) {
  const role = config.role ?? 'hub'
  if (role === 'node') return node(ctx, config)
  if (role !== 'hub') throw new Error(`dsh-hub: role is hub or node, not ${role}`)
  ctx.inject(HUB_SERVICES, scope => hub(scope, config))
}

function hub (ctx, config) {
  const log = logger(ctx, 'dsh-hub')
  let running = null
  let closed = false
  const started = (async () => {
    const folder = config.folder ? path.resolve(config.folder) : await home()
    const brain = await dshBrain(ctx, {
      bots: config.bots, title: config.title ?? 'Hub', model: config.model, permission: config.permission ?? 'workspace-write',
      workspace: config.workspace ?? path.join(folder, 'workspace'), log,
      toolDefinitions: computerTools(null).map(({ name, description, parameters }) => ({ name, description, parameters })),
    })
    const hubRunning = await startHub({
      folder: path.join(folder, 'hub'), host: config.host, port: config.port, access: config.access,
      hostnames: config.hostnames, trustProxy: config.trustProxy, tls: config.tls, title: config.title,
      maxUploadMB: config.maxUploadMB, brain, log,
    })
    if (closed) await hubRunning.close()
    else running = hubRunning
  })()
  started.catch(error => log('start_failed', { error: String(error?.stack || error) }))
  ctx.effect(() => () => {
    closed = true
    started.finally(() => running?.close()).catch(() => {})
  })
}

function node (ctx, config) {
  const log = logger(ctx, 'dsh-hub node')
  let agent = null
  let closed = false
  const started = (async () => {
    const folder = config.folder ? path.resolve(config.folder) : await home()
    const file = path.join(folder, 'node.json')
    let kept = readConfig(file)
    if (!kept?.secret || (config.hub && kept.hub && new URL(config.hub).origin !== new URL(kept.hub).origin)) {
      if (!config.hub || !config.code) {
        log('not_joined', { hint: 'Set hub and code (a pairing code from the hub\'s page: Computers, Add) in this plugin\'s config.' })
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
    agent.start()
  })()
  started.catch(error => log('start_failed', { error: String(error?.message || error) }))
  ctx.effect(() => () => {
    closed = true
    agent?.stop()
  })
}
