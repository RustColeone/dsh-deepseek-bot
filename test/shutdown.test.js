// Stopping: DSH's desktop app gives its Host 10 seconds to stop when it restarts for an update, and refuses the update
// when it takes longer. A hub with pages and computers connected still has to stop at once.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import WebSocket from 'ws'
import { echoBrain } from '../lib/brain-echo.js'
import { NodeAgent, enroll } from '../lib/node-agent.js'
import { startHub } from '../lib/start.js'

test('a hub with a page open, a computer connected and an idle connection stops within two seconds', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hub-stop-'))
  const log = console.log
  console.log = () => {}
  const hub = await startHub({ folder, host: '127.0.0.1', port: 0, brain: echoBrain(), log: () => {} })
  console.log = log
  const base = `http://127.0.0.1:${hub.port}`
  const made = await fetch(base + '/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ code: hub.accounts.setupCode, name: 'leo', password: 'a fine long password' }) })
  const cookie = made.headers.get('set-cookie').split(';')[0]

  // the page, as a phone has it open
  const page = new WebSocket(base.replace(/^http/, 'ws') + '/ws', { headers: { Cookie: cookie, Origin: base } })
  await new Promise((resolve, reject) => { page.once('open', resolve); page.once('error', reject) })
  // a computer, connected
  const pairing = await (await fetch(base + '/api/nodes/pair', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie }, body: JSON.stringify({ name: 'ROG' }) })).json()
  const config = await enroll({ hub: base, code: pairing.code, info: { hostname: 'rog' } })
  const agent = new NodeAgent({ config, log: () => {}, inbox: path.join(folder, 'inbox') })
  agent.start()
  for (let i = 0; i < 100 && !hub.nodes.online(config.id); i++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(hub.nodes.online(config.id))
  // a browser's idle keep-alive connection
  const keep = new http.Agent({ keepAlive: true })
  await new Promise((resolve, reject) => http.get(base + '/login', { agent: keep }, response => { response.resume(); response.on('end', resolve) }).on('error', reject))

  const started = Date.now()
  await Promise.race([
    hub.close(),
    new Promise((resolve, reject) => setTimeout(() => reject(new Error('the hub did not stop within 2 s')), 2000).unref()),
  ])
  assert.ok(Date.now() - started < 2000)
  assert.equal(page.readyState === WebSocket.OPEN, false, 'the page is told the hub is gone')
  agent.stop()
  keep.destroy()
  fs.rmSync(folder, { recursive: true, force: true })
})
