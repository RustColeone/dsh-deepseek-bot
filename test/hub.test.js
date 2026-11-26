// The hub end to end, with the echo brain: accounts, the guard, chatting, and a real node on this computer running a
// command after it is approved.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import WebSocket from 'ws'
import { checkPassword, hashPassword, verifyPassword } from '../lib/auth.js'
import { echoBrain } from '../lib/brain-echo.js'
import { isHomeHost, isLocalAddress } from '../lib/guard.js'
import { NodeAgent, enroll, refusal } from '../lib/node-agent.js'
import { startHub } from '../lib/start.js'

describe('guard', () => {
  test('local addresses', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '192.168.1.20', '169.254.1.1', '100.101.102.103',
      '::1', '::ffff:192.168.1.5', 'fd7a:115c:a1e0::1', 'fe80::1%eth0']) assert.ok(isLocalAddress(address), address)
    for (const address of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2001:4860::8888', '::ffff:1.1.1.1', 'nonsense']) {
      assert.ok(!isLocalAddress(address), address)
    }
  })
  test('home host names', () => {
    for (const host of ['localhost:4180', '192.168.1.5:4180', '[::1]:4180', 'rog:4180', 'hub.local', 'pc.tail1234.ts.net']) {
      assert.ok(isHomeHost(host), host)
    }
    for (const host of ['evil.example.com', 'attacker.net:4180', '']) assert.ok(!isHomeHost(host), host)
    assert.ok(isHomeHost('hub.example.com', ['hub.example.com']))
  })
})

describe('passwords', () => {
  test('hash and verify', async () => {
    const kept = await hashPassword('correct horse battery')
    assert.match(kept, /^scrypt\$32768\$8\$1\$/)
    assert.ok(await verifyPassword('correct horse battery', kept))
    assert.ok(!await verifyPassword('wrong horse battery', kept))
    assert.ok(!await verifyPassword('anything', null))
  })
  test('rules', () => {
    assert.ok(checkPassword('short'))
    assert.ok(checkPassword('aaaaaaaaaaaa'))
    assert.ok(checkPassword('leo-is-my-name-1', 'leo'))
    assert.equal(checkPassword('a fine long password'), '')
  })
  test('node policy', () => {
    assert.equal(refusal({ exec: 'any' }, 'rm -rf /'), '')
    assert.match(refusal({ exec: 'never' }, 'ls'), /never/)
    assert.equal(refusal({ exec: 'allowlist', allow: ['^video2x '] }, 'video2x -i a.mp4'), '')
    assert.match(refusal({ exec: 'allowlist', allow: ['^video2x '] }, 'del *'), /allow list/)
  })
})

/** A websocket that keeps every event, and waits for the one wanted. */
function socket (url, cookie) {
  const ws = new WebSocket(url, { headers: { Cookie: cookie, Origin: url.replace(/^ws/, 'http').replace(/\/ws$/, '') } })
  const events = []
  const waiting = []
  ws.on('message', data => {
    const event = JSON.parse(String(data))
    events.push(event)
    for (const wait of [...waiting]) if (wait.match(event)) { waiting.splice(waiting.indexOf(wait), 1); wait.resolve(event) }
  })
  return {
    ws, events,
    opened: new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); ws.once('unexpected-response', (q, r) => reject(new Error(String(r.statusCode)))) }),
    next (match, ms = 10000) {
      const found = events.find(match)
      if (found) { events.splice(events.indexOf(found), 1); return Promise.resolve(found) }
      return new Promise((resolve, reject) => {
        const wait = { match, resolve: event => { clearTimeout(timer); events.splice(events.indexOf(event), 1); resolve(event) } }
        const timer = setTimeout(() => { waiting.splice(waiting.indexOf(wait), 1); reject(new Error('timed out waiting for an event')) }, ms)
        waiting.push(wait)
      })
    },
    send (event) { ws.send(JSON.stringify(event)) },
  }
}

/** A node's DSH agents, without DSH: one bot, ROG, that asks for approval and posts a file when asked to. */
function fakeNodeBrain ({ posted, heard }) {
  const bots = [{ name: 'rog', display: 'ROG', description: 'The gaming PC' }]
  return {
    bots: () => bots.map(bot => ({ ...bot })),
    async create ({ display, description }) {
      const bot = { name: display.toLowerCase().replace(/\s+/g, '-'), display, description }
      bots.push(bot)
      return bot
    },
    async remove (name) { bots.splice(bots.findIndex(bot => bot.name === name), 1) },
    async run ({ mode, bot, session, text, sink, approve, postFile }) {
      heard.push({ mode, bot, session, text })
      sink.activity('thinking…')
      if (text.includes('ask') && await approve({ tool: 'pwsh', summary: 'Check the time', detail: 'Get-Date' }) !== 'approved') {
        return { text: 'not allowed', session: session || `session-${mode}` }
      }
      if (text.includes('post')) await postFile(posted)
      sink.stream('…')
      return { text: `${mode === 'reply' ? bot : 'task'} heard: ${text.split('\n')[0]}`, session: session || `session-${mode}` }
    },
  }
}

describe('hub', () => {
  let hub, base, folder, cookie, page, agent
  const post = (route, body, headers = {}) => fetch(base + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: JSON.stringify(body),
  })

  before(async () => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hub-test-'))
    const quiet = () => {}
    const log = console.log
    console.log = quiet // the setup code banner
    hub = await startHub({ folder, host: '127.0.0.1', port: 0, brain: echoBrain(), log: quiet })
    console.log = log
    base = `http://127.0.0.1:${hub.port}`
  })
  after(async () => {
    agent?.stop()
    page?.ws.close()
    await hub.close()
    fs.rmSync(folder, { recursive: true, force: true })
  })

  test('an empty hub sends you to set up, and only the console\'s code makes the owner', async () => {
    const first = await fetch(base + '/', { redirect: 'manual' })
    assert.equal(first.status, 303)
    assert.equal(first.headers.get('location'), 'setup')
    const setupPage = await fetch(base + '/setup')
    assert.equal(setupPage.status, 200)
    assert.match(await setupPage.text(), /Setup code/)
    assert.match(setupPage.headers.get('content-security-policy'), /default-src 'self'/)
    assert.equal((await fetch(base + '/static/../lib/auth.js')).status, 404)
    const wrong = await post('/api/setup', { code: 'AAAA-BBBB-CCCC', name: 'leo', password: 'a fine long password' })
    assert.equal(wrong.status, 400)
    const right = await post('/api/setup', { code: hub.accounts.setupCode, name: 'leo', password: 'a fine long password' })
    assert.equal(right.status, 200)
    cookie = right.headers.get('set-cookie').split(';')[0]
    assert.match(right.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/)
    const again = await post('/api/setup', { code: 'x', name: 'other', password: 'another long password' })
    assert.equal(again.status, 400)
  })

  test('signing in, and wrong passwords', async () => {
    const saved = cookie
    cookie = ''
    const wrong = await post('/api/login', { name: 'leo', password: 'not the password' })
    assert.equal(wrong.status, 401)
    const right = await post('/api/login', { name: 'LEO', password: 'a fine long password' })
    assert.equal(right.status, 200)
    cookie = saved
    const chatPage = await fetch(base + '/', { headers: { Cookie: cookie } })
    assert.equal(chatPage.status, 200)
    assert.match(await chatPage.text(), /static\/app\.js/)
    assert.equal((await fetch(base + '/login', { redirect: 'manual', headers: { Cookie: cookie } })).status, 303)
    const me =await (await fetch(base + '/api/me', { headers: { Cookie: cookie } })).json()
    assert.equal(me.user.name, 'leo')
    assert.equal(me.user.role, 'owner')
  })

  test('the guard refuses other origins, other host names and no cookie', async () => {
    assert.equal((await post('/api/nodes/pair', { name: 'x' }, { Origin: 'http://evil.example.com' })).status, 403)
    // (fetch drops a Host header of its own; node:http sends it, as a DNS-rebinding page's browser would)
    const rebound = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: hub.port, path: '/api/me', headers: { Host: 'evil.example.com', Cookie: cookie } },
        response => { response.resume(); resolve(response.statusCode) }).on('error', reject)
    })
    assert.equal(rebound, 403)
    assert.equal((await fetch(base + '/api/me')).status, 401)
    assert.equal((await fetch(base + '/api/history?conversation=x')).status, 401)
    const stranger = socket(`ws://127.0.0.1:${hub.port}/ws`, '')
    await assert.rejects(stranger.opened, /401/)
  })

  test('chatting: your message, then the reply streams in', async () => {
    page = socket(`ws://127.0.0.1:${hub.port}/ws`, cookie)
    await page.opened
    const hello = await page.next(event => event.type === 'hello')
    assert.equal(hello.state.user.name, 'leo')
    assert.deepEqual(hello.state.bots.map(bot => bot.display), ['Echo', 'Parrot'])
    const chat = hello.state.default
    page.send({ type: 'send', conversation: chat, id: 'm1', text: 'hello there' })
    assert.ok((await page.next(event => event.type === 'ack' && event.id === 'm1')).ok)
    await page.next(event => event.type === 'message' && event.item.kind === 'user')
    await page.next(event => event.type === 'progress' && event.text)
    const reply = await page.next(event => event.type === 'message' && event.item.kind === 'text')
    assert.equal(reply.item.speaker, 'Echo')
    assert.equal(reply.item.text, 'hello there')
    // In a group chat, @Parrot picks Parrot.
    page.send({ type: 'send', conversation: chat, id: 'm2', text: '@Parrot loud' })
    const parrot = await page.next(event => event.type === 'message' && event.item.kind === 'text')
    assert.equal(parrot.item.speaker, 'Parrot')
    assert.match(parrot.item.text, /LOUD!$/)
    assert.match(parrot.item.text, /heard 2 other messages/) // what was said since Parrot last spoke
  })

  test('a computer joins with a pairing code and runs a command once you approve it', async () => {
    const pairing = await (await post('/api/nodes/pair', { name: 'Test PC' })).json()
    assert.match(pairing.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
    const config = await enroll({ hub: base, code: pairing.code, info: { hostname: 'test', platform: process.platform } })
    assert.equal(config.name, 'Test PC')
    // The code works once.
    await assert.rejects(enroll({ hub: base, code: pairing.code, info: {} }), /wrong, used or expired/)
    agent = new NodeAgent({ config, log: () => {}, inbox: path.join(folder, 'node-inbox') })
    agent.start()
    await page.next(event => event.type === 'nodes' && event.nodes.some(node => node.name === 'Test PC' && node.online && node.info.cpu))

    const chat = hub.hub.store.chats(1)[0].id
    page.send({ type: 'send', conversation: chat, id: 'm3', text: 'run Test PC: echo hi-from-node' })
    const card = await page.next(event => event.type === 'message' && event.item.kind === 'approval')
    assert.equal(card.item.data.detail, 'echo hi-from-node')
    page.send({ type: 'decide', message: card.item.id, decision: 'approved' })
    const decided = await page.next(event => event.type === 'update' && event.item.id === card.item.id)
    assert.equal(decided.item.decided, 'approved')
    await page.next(event => event.type === 'message' && event.item.kind === 'job')
    const done = await page.next(event => event.type === 'update' && event.item.kind === 'job' && event.item.data.status !== 'running', 20000)
    assert.equal(done.item.data.status, 'done')
    assert.match(done.item.data.output, /hi-from-node/)
    const reply = await page.next(event => event.type === 'message' && event.item.kind === 'text', 20000)
    assert.match(reply.item.text, /hi-from-node/)
  })

  test('a denied command does not run; a computer set to never refuses outright', async () => {
    const chat = hub.hub.store.chats(1)[0].id
    page.send({ type: 'send', conversation: chat, id: 'm4', text: 'run Test PC: echo should-not-run' })
    const card = await page.next(event => event.type === 'message' && event.item.kind === 'approval')
    page.send({ type: 'decide', message: card.item.id, decision: 'denied' })
    const reply = await page.next(event => event.type === 'message' && event.item.kind === 'text', 20000)
    assert.match(reply.item.text, /denied/)
    const node = hub.nodes.list()[0]
    assert.equal((await post('/api/nodes/update', { id: node.id, policy: 'never' })).status, 200)
    page.send({ type: 'send', conversation: chat, id: 'm5', text: 'run Test PC: echo nope' })
    const refused = await page.next(event => event.type === 'message' && event.item.kind === 'text', 20000)
    assert.match(refused.item.text, /switched off/)
  })

  test('the node\'s own policy has the last word', async () => {
    const node = hub.nodes.list()[0]
    await post('/api/nodes/update', { id: node.id, policy: 'always' })
    agent.config.policy = { exec: 'never' }
    const chat = hub.hub.store.chats(1)[0].id
    page.send({ type: 'send', conversation: chat, id: 'm6', text: 'run Test PC: echo nope' })
    const reply = await page.next(event => event.type === 'message' && event.item.kind === 'text', 20000)
    assert.match(reply.item.text, /policy is never/)
    agent.config.policy = { exec: 'any' }
  })

  test('a file goes from the chat to a computer, and one comes back into the chat', async () => {
    const chat = hub.hub.store.chats(1)[0].id
    const node = hub.nodes.list()[0]
    assert.equal(node.policy, 'always') // from the last test: no card for the way there
    // The phone's upload: the file itself as the body.
    const video = crypto.randomBytes(300 * 1024 + 7)
    const uploaded = await (await fetch(`${base}/api/upload?name=clip.mp4`, {
      method: 'POST', headers: { 'Content-Type': 'video/mp4', Origin: base, Cookie: cookie }, body: video,
    })).json()
    assert.equal(uploaded.file.size, video.length)
    page.send({ type: 'send', conversation: chat, id: 'm7', text: 'send to Test PC', files: [uploaded.file.id] })
    const sent = await page.next(event => event.type === 'update' && event.item.data?.kind === 'send' &&
      !['starting', 'running'].includes(event.item.data.status), 20000)
    assert.equal(sent.item.data.status, 'done', sent.item.data.error)
    const there = sent.item.data.result.path
    assert.equal(path.dirname(there), path.join(folder, 'node-inbox'))
    assert.ok(fs.readFileSync(there).equals(video))
    assert.match(sent.item.data.output, /received .*100%/)
    await page.next(event => event.type === 'message' && event.item.kind === 'text', 20000)

    // The way back asks first; the file arrives in the chat as the bot's, and plays from the hub.
    await post('/api/nodes/update', { id: node.id, policy: 'ask' })
    const result = path.join(folder, 'upscaled.mp4')
    const made = crypto.randomBytes(200 * 1024)
    fs.writeFileSync(result, made)
    page.send({ type: 'send', conversation: chat, id: 'm8', text: `get Test PC: ${result}` })
    const card = await page.next(event => event.type === 'message' && event.item.kind === 'approval')
    assert.equal(card.item.data.title, 'Bring a file from Test PC?')
    page.send({ type: 'decide', message: card.item.id, decision: 'approved' })
    const arrived = await page.next(event => event.type === 'message' && event.item.kind === 'file', 20000)
    assert.equal(arrived.item.speaker, 'Parrot') // the bot that asked for it: its turn, as it spoke last here
    const [file] = arrived.item.files
    assert.equal(file.name, 'upscaled.mp4')
    assert.equal(file.mime, 'video/mp4')
    const served = await fetch(`${base}/files/${file.id}`, { headers: { Cookie: cookie } })
    assert.equal(served.status, 200)
    assert.ok(Buffer.from(await served.arrayBuffer()).equals(made))
    const reply = await page.next(event => event.type === 'message' && event.item.kind === 'text', 20000)
    assert.match(reply.item.text, /"status": "done"/)
  })

  test('a file ticket is one computer\'s own, and the computer\'s file policy has the last word', async () => {
    const chat = hub.hub.store.chats(1)[0].id
    const node = hub.nodes.list()[0]
    await post('/api/nodes/update', { id: node.id, policy: 'always' })
    assert.equal((await fetch(`${base}/api/nodes/download?ticket=${'a'.repeat(43)}`)).status, 401)
    const auth = { Authorization: `Bearer ${agent.config.id}.${agent.config.secret}` }
    assert.equal((await fetch(`${base}/api/nodes/download?ticket=${'a'.repeat(43)}`, { headers: auth })).status, 403)
    assert.equal((await fetch(`${base}/api/nodes/upload?ticket=${'a'.repeat(43)}&name=x.txt`, { method: 'POST', headers: auth, body: 'x' })).status, 403)

    agent.config.policy = { exec: 'any', files: 'never' }
    page.send({ type: 'send', conversation: chat, id: 'm9', text: `get Test PC: ${path.join(folder, 'upscaled.mp4')}` })
    const never = await page.next(event => event.type === 'message' && event.item.kind === 'text', 20000)
    assert.match(never.item.text, /file policy is never/)

    agent.config.policy = { exec: 'any', files: 'folders', folders: [path.join(folder, 'allowed')] }
    page.send({ type: 'send', conversation: chat, id: 'm10', text: `get Test PC: ${path.join(folder, 'upscaled.mp4')}` })
    const outside = await page.next(event => event.type === 'message' && event.item.kind === 'text', 20000)
    assert.match(outside.item.text, /not in a folder/)
    agent.config.policy = { exec: 'any' }
  })

  test('a bot living on a computer answers there, asks for approval, and posts files; another can be added', async () => {
    const posted = path.join(folder, 'from-rog.png')
    fs.writeFileSync(posted, crypto.randomBytes(1000))
    const heard = []
    agent.setBrain(fakeNodeBrain({ posted, heard }))
    const listed = await page.next(event => event.type === 'bots' && event.bots.some(bot => bot.display === 'ROG'))
    const rog = listed.bots.find(bot => bot.display === 'ROG')
    assert.equal(rog.home, 'Test PC')
    assert.match(rog.name, /^@n[0-9a-f]{12}\/rog$/)

    page.send({ type: 'new', conversation: 'chat-rog', title: 'ROG', bots: [rog.name] })
    await page.next(event => event.type === 'conversations' && event.items.some(chat => chat.id === 'chat-rog'))
    page.send({ type: 'send', conversation: 'chat-rog', id: 'r1', text: 'hello, please ask and post' })
    const card = await page.next(event => event.type === 'message' && event.item.kind === 'approval', 20000)
    assert.equal(card.item.data.title, 'May ROG use pwsh on Test PC?')
    assert.equal(card.item.data.detail, 'Get-Date')
    page.send({ type: 'decide', message: card.item.id, decision: 'approved' })
    const file = await page.next(event => event.type === 'message' && event.item.kind === 'file', 20000)
    assert.equal(file.item.speaker, 'ROG')
    assert.equal(file.item.files[0].mime, 'image/png')
    const reply = await page.next(event => event.type === 'message' && event.item.kind === 'text', 20000)
    assert.equal(reply.item.speaker, 'ROG')
    assert.equal(reply.item.text, 'rog heard: hello, please ask and post')
    assert.equal(hub.hub.store.chat('chat-rog').state.sessions[rog.name], 'session-reply')

    // An attachment for it is copied to its computer first, and it reads the path there.
    const uploaded = await (await fetch(`${base}/api/upload?name=notes.txt`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain', Origin: base, Cookie: cookie }, body: 'some notes',
    })).json()
    page.send({ type: 'send', conversation: 'chat-rog', id: 'r2', text: 'read this', files: [uploaded.file.id] })
    await page.next(event => event.type === 'update' && event.item.data?.kind === 'send' && event.item.data.status === 'done', 20000)
    await page.next(event => event.type === 'message' && event.item.kind === 'text', 20000)
    assert.match(heard.at(-1).text, /on this computer at .*node-inbox.*notes\.txt\]/)
    assert.equal(heard.at(-1).session, 'session-reply') // the same session goes on

    // The owner adds a bot to live there from the page.
    const node = hub.nodes.list()[0]
    const added = await (await post('/api/nodes/bots', { node: node.id, display: 'Pi Bot', description: 'small' })).json()
    assert.equal(added.bot.name, 'pi-bot')
    await page.next(event => event.type === 'bots' && event.bots.some(bot => bot.display === 'Pi Bot'))
    assert.equal((await post('/api/nodes/bots', { node: node.id, display: 'rog' })).status, 400) // names are unique
  })

  test('a hub bot hands a task to an agent on a computer, which reports back', async () => {
    const chat = hub.hub.store.chats(1).find(item => item.id !== 'chat-rog').id
    page.send({ type: 'send', conversation: chat, id: 't1', text: 'delegate Test PC: count the files in the inbox' })
    const done = await page.next(event => event.type === 'update' && event.item.data?.kind === 'agent' &&
      !['starting', 'running'].includes(event.item.data.status), 20000)
    assert.equal(done.item.data.status, 'done', done.item.data.error)
    assert.equal(done.item.data.result.text, 'task heard: count the files in the inbox')
    assert.equal(done.item.data.result.session, 'session-task')
    assert.match(done.item.data.output, /· thinking…/)
    const reply = await page.next(event => event.type === 'message' && event.item.kind === 'text', 20000)
    assert.match(reply.item.text, /task heard: count the files/)
  })

  test('changing the password signs the page out', async () => {
    const closed = new Promise(resolve => page.ws.once('close', code => resolve(code)))
    const answer = await post('/api/password', { current: 'a fine long password', next: 'a newer long password' })
    assert.equal(answer.status, 200)
    assert.equal((await fetch(base + '/api/me', { headers: { Cookie: cookie } })).status, 401)
    void closed // the page's check runs every 30 s; that it is refused now is what matters
  })
})
