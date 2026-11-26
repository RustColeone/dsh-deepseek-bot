#!/usr/bin/env node
// dsh-hub's command line: setting up the DSH plugin on this computer (`dsh-hub config`), and dsh-hub without DeepSeek
// Harness around it: a hub with the echo brain (for trying the page and the nodes out), and a computer joining a hub
// as a node. Inside DSH the plugin does both (plugin/index.js).
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { Accounts } from '../lib/auth.js'
import { echoBrain } from '../lib/brain-echo.js'
import { NodeAgent, defaultConfigPath, enroll, readConfig, writeConfig } from '../lib/node-agent.js'
import { FIELDS, change, dshHome, readSettings, settingsFile, writeSettings } from '../lib/settings.js'
import { DEFAULT_PORT, consoleLog, defaultFolder, startHub } from '../lib/start.js'
import { Store } from '../lib/store.js'

const HELP = `dsh-hub: one computer as the hub of your others.

  Setting up the DSH plugin on this computer (a running DSH follows within seconds; DSH's Plugins page does the same):
  dsh-hub config                  what this computer is set to (and the hub's setup code, until it has an account)
  dsh-hub config hub              make it the hub
  dsh-hub config join <hub> <code>   make it a node of a hub, with a pairing code from that hub's page
  dsh-hub config off              neither
  dsh-hub config set <name> <value>  one setting (dsh-hub config lists them); unset <name> puts it back
  dsh-hub config forget           forget the hub this computer joined
      --dsh-home <folder>         DSH's home, default ${dshHome()}

  Without DSH:

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
      --data <folder>             default ${defaultFolder()}; --dsh: the DSH plugin's hub
`

/** `dsh-hub config ...`: the settings file the plugin reads, in <DSH home>/dsh-hub. */
async function configure (rest, values) {
  const folder = path.join(values['dsh-home'] ? path.resolve(values['dsh-home']) : dshHome(), 'dsh-hub')
  const [what, ...args] = rest
  let settings = readSettings(folder)
  const nodeFile = path.join(folder, 'node.json')
  const save = next => { settings = writeSettings(folder, next) }
  if (what === 'hub' || what === 'off') save(change(settings, 'role', what))
  else if (what === 'join') {
    const [hub, code] = args
    if (!hub || !code) throw new Error('Use: dsh-hub config join <hub address> <pairing code>')
    const address = change(settings, 'node.hub', hub).node.hub
    const kept = await enroll({ hub: address, code })
    writeConfig(nodeFile, kept)
    save(change(change(settings, 'node.hub', address), 'role', 'node'))
    console.log(`Joined ${kept.hub} as "${kept.name}".`)
  } else if (what === 'set' || what === 'unset') {
    const [name, ...value] = args
    if (!name || (what === 'set' && !value.length)) throw new Error(`Use: dsh-hub config ${what} <name>${what === 'set' ? ' <value>' : ''}`)
    save(change(settings, name, what === 'set' ? value.join(' ') : undefined))
  } else if (what === 'forget') {
    try { fs.unlinkSync(nodeFile); console.log('Forgot the hub this computer joined.') } catch { console.log('This computer had not joined a hub.') }
  } else if (what) throw new Error(`Unknown: dsh-hub config ${what}. dsh-hub help lists what there is.`)

  const role = settings.role ?? (fs.existsSync(path.join(folder, 'hub', 'hub.db')) ? 'hub (it has one already)' : 'off (not chosen yet)')
  console.log(`This computer: ${role}. Settings in ${settingsFile(folder)}; a profile's cordis.patch.yml wins over them.`)
  const shown = Object.keys(FIELDS).filter(name => name.startsWith(String(settings.role ?? 'hub') + '.'))
  for (const name of shown) {
    const value = name.split('.').reduce((at, key) => at?.[key], settings)
    console.log(`  ${name.padEnd(22)} ${value === undefined ? '-' : Array.isArray(value) ? value.join(', ') : value}`)
  }
  if (settings.role === 'node') {
    const kept = readConfig(nodeFile)
    console.log(kept?.secret ? `Joined ${kept.hub} as "${kept.name}".` : 'Not joined to a hub yet: dsh-hub config join <hub> <code>.')
  }
  const code = path.join(folder, 'hub', 'setup-code.txt')
  if (settings.role !== 'node' && fs.existsSync(code)) {
    console.log(`The hub has no account yet. Its setup code: ${fs.readFileSync(code, 'utf8').trim().split(/\s+/)[0]} (open the hub's page, /setup).`)
  }
  if (!what) {
    console.log('')
    console.log('Every setting (dsh-hub config set <name> <value>):')
    for (const [name, field] of Object.entries(FIELDS)) console.log(`  ${name.padEnd(22)} ${field.help}`)
  }
}

async function main () {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string' }, host: { type: 'string' }, access: { type: 'string' },
      hostname: { type: 'string', multiple: true }, 'trust-proxy': { type: 'string', multiple: true },
      'tls-cert': { type: 'string' }, 'tls-key': { type: 'string' }, data: { type: 'string' }, title: { type: 'string' },
      config: { type: 'string' }, help: { type: 'boolean', short: 'h' }, 'dsh-home': { type: 'string' }, dsh: { type: 'boolean' },
    },
  })
  const [command, ...rest] = positionals
  if (!command || values.help || command === 'help') { console.log(HELP); return }
  if (command === 'config') return configure(rest, values)

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
    const store = new Store(values.data ? path.resolve(values.data)
      : values.dsh ? path.join(values['dsh-home'] ? path.resolve(values['dsh-home']) : dshHome(), 'dsh-hub', 'hub') : defaultFolder())
    const answer = await new Accounts(store).resetPassword(name)
    store.close()
    if (answer.error) throw new Error(answer.error)
    console.log(`New password for ${answer.user.name}: ${answer.password}\nIt is signed out everywhere. Change it after signing in.`)
    return
  }

  throw new Error(`Unknown command ${command}. dsh-hub help lists them.`)
}

main().catch(error => { console.error(error.message); process.exit(1) })
