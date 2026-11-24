#!/usr/bin/env node
// dsh-hub without DeepSeek Harness around it: a hub with the echo brain (for trying the page and the nodes out), and
// a computer joining a hub as a node. Inside DSH the plugin does both (plugin/index.js).
import path from 'node:path'
import { parseArgs } from 'node:util'
import { Accounts } from '../lib/auth.js'
import { echoBrain } from '../lib/brain-echo.js'
import { NodeAgent, defaultConfigPath, enroll, readConfig, writeConfig } from '../lib/node-agent.js'
import { DEFAULT_PORT, consoleLog, defaultFolder, startHub } from '../lib/start.js'
import { Store } from '../lib/store.js'

const HELP = `dsh-hub: one computer as the hub of your others.

  dsh-hub hub [options]           start a hub (with the echo brain: no model, for trying it out)
      --port <n>                  default ${DEFAULT_PORT}
      --host <address>            default 0.0.0.0 (every network of this computer)
      --access lan|anywhere       who may reach the sign-in page; default lan (home network and Tailscale)
      --hostname <name>           a name of yours the hub is opened by (repeatable)
      --trust-proxy <address>     a reverse proxy whose X-Forwarded-* to believe (repeatable)
      --tls-cert <file> --tls-key <file>   serve https
      --data <folder>             default ${defaultFolder()}
      --title <text>              the page's title

  dsh-hub join <hub> <code>       join this computer to a hub with a pairing code from its page
      --config <file>             default ${defaultConfigPath()}
  dsh-hub node                    run this computer as a node of the hub it joined
      --config <file>
  dsh-hub password <name>         a new random password for an account (on the hub's computer)
      --data <folder>
`

async function main () {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string' }, host: { type: 'string' }, access: { type: 'string' },
      hostname: { type: 'string', multiple: true }, 'trust-proxy': { type: 'string', multiple: true },
      'tls-cert': { type: 'string' }, 'tls-key': { type: 'string' }, data: { type: 'string' }, title: { type: 'string' },
      config: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    },
  })
  const [command, ...rest] = positionals
  if (!command || values.help || command === 'help') { console.log(HELP); return }

  if (command === 'hub') {
    const hub = await startHub({
      folder: values.data ? path.resolve(values.data) : undefined,
      port: values.port ? Number(values.port) : undefined, host: values.host, access: values.access,
      hostnames: values.hostname, trustProxy: values['trust-proxy'], title: values.title,
      tls: values['tls-cert'] ? { cert: values['tls-cert'], key: values['tls-key'] } : null,
      brain: echoBrain(), log: consoleLog('hub'),
    })
    const stop = async () => { await hub.close(); process.exit(0) }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    return
  }

  if (command === 'join') {
    const [hub, code] = rest
    if (!hub || !code) throw new Error('Use: dsh-hub join <hub address> <pairing code>')
    const file = values.config ? path.resolve(values.config) : defaultConfigPath()
    const config = await enroll({ hub, code })
    writeConfig(file, { ...readConfig(file), ...config })
    console.log(`Joined ${config.hub} as "${config.name}". Kept in ${file}.\nRun \`dsh-hub node\` (or DSH with the plugin as a node) to connect.`)
    return
  }

  if (command === 'node') {
    const file = values.config ? path.resolve(values.config) : defaultConfigPath()
    const config = readConfig(file)
    if (!config) throw new Error(`This computer has not joined a hub (no ${file}). Use: dsh-hub join <hub> <code>`)
    const agent = new NodeAgent({ config, log: consoleLog(`node ${config.name}`) })
    agent.start()
    const stop = () => { agent.stop(); process.exit(0) }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    return
  }

  if (command === 'password') {
    const [name] = rest
    if (!name) throw new Error('Use: dsh-hub password <account name>')
    const store = new Store(values.data ? path.resolve(values.data) : defaultFolder())
    const answer = await new Accounts(store).resetPassword(name)
    store.close()
    if (answer.error) throw new Error(answer.error)
    console.log(`New password for ${answer.user.name}: ${answer.password}\nIt is signed out everywhere. Change it after signing in.`)
    return
  }

  throw new Error(`Unknown command ${command}. dsh-hub help lists them.`)
}

main().catch(error => { console.error(error.message); process.exit(1) })
