// Setting the plugin up: the settings file, what a computer runs from it, joining a hub from DSH's page, the command
// line, and the page itself.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { echoBrain } from '../lib/brain-echo.js'
import { change, clean, effective, readSettings, writeSettings } from '../lib/settings.js'
import { startHub } from '../lib/start.js'
import { control } from '../plugin/control.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hub-settings-'))

describe('settings', () => {
  test('a fresh computer is off; one that already has a hub stays a hub', () => {
    const folder = scratch()
    assert.equal(effective({}, readSettings(folder), folder).role, 'off')
    fs.mkdirSync(path.join(folder, 'hub'))
    fs.writeFileSync(path.join(folder, 'hub', 'hub.db'), '')
    assert.equal(effective({}, readSettings(folder), folder).role, 'hub')
    writeSettings(folder, { role: 'off' })
    assert.equal(effective({}, readSettings(folder), folder).role, 'off')
    fs.rmSync(folder, { recursive: true })
  })

  test('the profile\'s own config wins, and is locked', () => {
    const settings = clean({ role: 'node', node: { hub: '192.168.1.10:4180', policy: { exec: 'never', files: 'any' } } })
    assert.equal(settings.node.hub, 'http://192.168.1.10:4180')
    const chosen = effective({ policy: { files: 'never' } }, settings)
    assert.equal(chosen.role, 'node')
    assert.deepEqual(chosen.config.policy, { exec: 'never', files: 'never' })
    assert.deepEqual(chosen.locked, ['node.policy.files'])
    const hub = effective({ role: 'hub', port: 4190 }, clean({ role: 'node', hub: { port: 4181 } }))
    assert.equal(hub.role, 'hub')
    assert.equal(hub.config.port, 4190)
    assert.deepEqual(hub.locked, ['role', 'hub.port'])
  })

  test('bad settings are refused, with what is allowed', () => {
    assert.throws(() => clean({ role: 'server' }), /role is off, hub or node/)
    assert.throws(() => clean({ hub: { port: 70000 } }), /port is a whole number/)
    assert.throws(() => change(clean({}), 'hub.colour', 'red'), /there is no setting hub.colour/)
    assert.deepEqual(clean({ hub: { hostnames: 'a.local, b.local,,' } }).hub.hostnames, ['a.local', 'b.local'])
    assert.deepEqual(clean({ hub: { port: '', title: '  ' } }).hub, {})
  })
})

describe('joining a hub from DSH\'s page', () => {
  let hub, base, cookie, folder
  before(async () => {
    folder = scratch()
    const log = console.log
    console.log = () => {}
    hub = await startHub({ folder: path.join(folder, 'the-hub'), host: '127.0.0.1', port: 0, brain: echoBrain(), log: () => {} })
    console.log = log
    base = `http://127.0.0.1:${hub.port}`
    const made = await fetch(base + '/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ code: hub.accounts.setupCode, name: 'leo', password: 'a fine long password' }) })
    cookie = made.headers.get('set-cookie').split(';')[0]
  })
  after(async () => {
    await hub.close()
    fs.rmSync(folder, { recursive: true, force: true })
  })

  test('a pairing code makes this computer a node, and a change of settings restarts its role', async () => {
    const started = []
    const here = path.join(folder, 'this-computer')
    const work = control({ folder: here, start: async (role, config, live) => { started.push({ role, config }); return async () => started.push({ stopped: role }) } })
    await work.refresh()
    assert.deepEqual(started, [{ role: 'off', config: { role: 'off' } }])
    assert.equal(work.state().role, 'off')

    const pairing = await (await fetch(base + '/api/nodes/pair', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie }, body: JSON.stringify({ name: 'ROG' }) })).json()
    await assert.rejects(work.join({ hub: base, code: 'WRON-GCOD' }), /wrong, used or expired/)
    const joined = await work.join({ hub: base, code: pairing.code })
    assert.equal(joined.role, 'node')
    assert.equal(joined.settings.node.hub, base)
    assert.ok(JSON.parse(fs.readFileSync(path.join(here, 'node.json'), 'utf8')).secret)
    assert.equal(started.at(-1).role, 'node')
    assert.equal(hub.nodes.list()[0].name, 'ROG')

    const saved = await work.save({ ...joined.settings, node: { ...joined.settings.node, policy: { exec: 'never' } } })
    assert.equal(saved.config.policy.exec, 'never')
    assert.deepEqual(started.slice(-2), [{ stopped: 'node' }, { role: 'node', config: { hub: base, policy: { exec: 'never' }, role: 'node' } }])
    await work.save(saved.settings) // the same again: nothing restarts
    assert.equal(started.length, 5)
    await work.forget()
    assert.equal(fs.existsSync(path.join(here, 'node.json')), false)
    await work.close()
  })

  test('a profile that is a hub can\'t be turned into a node from the page', async () => {
    const work = control({ folder: path.join(folder, 'locked'), profile: { role: 'hub' }, start: async () => null })
    await assert.rejects(work.save({ role: 'node' }), /cordis.patch.yml makes it a hub/)
    await assert.rejects(work.join({ hub: base, code: 'ABCD-EFGH' }), /cordis.patch.yml makes it a hub/)
    await work.close()
  })
})

test('dsh-hub config writes the same settings, and refuses a bad one', async () => {
  const home = scratch()
  const run = (...args) => promisify(execFile)(process.execPath, [path.join(root, 'bin', 'dsh-hub.js'), 'config', ...args, '--dsh-home', home])
  assert.match((await run()).stdout, /This computer: off \(not chosen yet\)/)
  await run('hub')
  await run('set', 'hub.port', '4181')
  await run('set', 'hub.hostnames', 'rog.local,', 'hub.local')
  await assert.rejects(run('set', 'hub.access', 'everyone'), /access is lan or anywhere/)
  assert.deepEqual(readSettings(path.join(home, 'dsh-hub')), { role: 'hub', hub: { port: 4181, hostnames: ['rog.local', 'hub.local'] }, node: {} })
  await run('unset', 'hub.port')
  assert.deepEqual(readSettings(path.join(home, 'dsh-hub')).hub, { hostnames: ['rog.local', 'hub.local'] })
  fs.rmSync(home, { recursive: true })
})

test('DSH\'s page: the plugin registers its settings, which show the setup code and the role\'s options', async () => {
  const require = createRequire(import.meta.url)
  const React = require('react')
  const { renderToStaticMarkup } = require('react-dom/server')
  let page = null
  globalThis.window = { __ModuleLoader__: { load: ({ id, factory }) => { assert.equal(id, 'dsh-hub'); page = factory(name => require(name)) } } }
  try {
    const source = fs.readFileSync(path.join(root, 'plugin', 'client.js'), 'utf8')
    new Function(source)() // as DSH's page runs a plugin's bundle: a script, not a module
  } finally { delete globalThis.window }
  const registered = []
  page.apply({
    effect: () => {}, locale: { register: () => {} },
    slots: { inject: (name, make) => { assert.equal(name, 'plugins.bundle.config'); make() }, register: (entry, view) => registered.push({ entry, view }) },
  })
  assert.equal(registered[0].entry.key, 'dsh-hub')
  const show = initial => renderToStaticMarkup(React.createElement(registered[0].view, { t: key => key, initial }))

  const hub = show({ role: 'hub', settings: { role: 'hub', hub: { port: 4181 } }, config: { role: 'hub', port: 4181 }, locked: [],
    folder: '/home/me/.dsh/dsh-hub', file: '/home/me/.dsh/dsh-hub/settings.json',
    status: { running: true, port: 4181, urls: ['http://localhost:4181/', 'http://192.168.0.5:4181/'], setupCode: 'ABCD-EFGH-JKLM', computers: { online: 1, total: 2 } } })
  assert.match(hub, /ABCD-EFGH-JKLM/)
  assert.ok(hub.indexOf('This computer') >= 0 && hub.indexOf('This computer') < hub.indexOf('The hub is running'), 'what the computer is comes first')
  assert.match(hub, /http:\/\/192\.168\.0\.5:4181\//)
  assert.match(hub, /1 of 2 computers online/)
  assert.match(hub, /value="4181"/)
  assert.doesNotMatch(hub, /Join a hub/)

  const node = show({ role: 'node', settings: { node: {} }, config: { role: 'node', policy: { exec: 'never' } }, locked: ['node.policy.exec'],
    folder: 'C:\\Users\\me\\.dsh\\dsh-hub', file: 'C:\\Users\\me\\.dsh\\dsh-hub\\settings.json', status: { joined: false } })
  assert.match(node, /Join a hub/)
  assert.match(node, /Not joined to a hub yet/)
  assert.match(node, /set in this profile&#x27;s cordis.patch.yml/)
  assert.match(node, /C:\\Users\\me\\.dsh\\dsh-hub\\inbox/)
})

test('in DSH, the role is a plugin of its own whose apply returns nothing (Cordis takes a value for an effect)', async () => {
  const { apply } = await import('../plugin/index.js')
  const folder = scratch()
  writeSettings(folder, { role: 'hub' })
  const children = []
  const disposers = []
  const fake = () => ({
    effect: make => { disposers.push(make()) },
    inject: () => ({ dispose () {} }), // what DSH's inject hands back: not an effect
    plugin: child => {
      const ctx = fake()
      children.push({ name: child.name, returned: child.apply(ctx) })
      return Object.assign(Promise.resolve(), { dispose: async () => {} })
    },
  })
  assert.equal(apply(fake(), { folder }), undefined)
  for (let i = 0; i < 50 && !children.length; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(children, [{ name: 'dsh-hub-hub', returned: undefined }])
  for (const dispose of disposers) await dispose?.()
  fs.rmSync(folder, { recursive: true, force: true })
})
