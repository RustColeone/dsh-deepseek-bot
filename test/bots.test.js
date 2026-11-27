// Making bots on the hub's page: presets, pictures, models, who may chat with them, the config's bots kept as they are.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import WebSocket from 'ws'
import { echoBrain } from '../lib/brain-echo.js'
import { presetPrompt } from '../lib/presets.js'
import { startHub } from '../lib/start.js'

// a 1×1 PNG
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
  '1f15c4890000000d49444154789c6360000002000154a24f5f0000000049454e44ae426082', 'hex')

async function quietHub (options) {
  const log = console.log
  console.log = () => {}
  try { return await startHub({ host: '127.0.0.1', port: 0, brain: echoBrain(), log: () => {}, ...options }) } finally { console.log = log }
}

describe('bots made on the page', () => {
  let running, base, folder, owner, member
  const post = (cookie, route, body, type = 'application/json') => fetch(base + route, {
    method: 'POST', headers: { 'Content-Type': type, Origin: base, Cookie: cookie }, body: type === 'application/json' ? JSON.stringify(body) : body,
  })
  const get = (cookie, route) => fetch(base + route, { headers: { Cookie: cookie } })

  before(async () => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hub-bots-'))
    running = await quietHub({ folder })
    base = `http://127.0.0.1:${running.port}`
    const made = await fetch(base + '/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ code: running.accounts.setupCode, name: 'leo', password: 'a fine long password' }) })
    owner = made.headers.get('set-cookie').split(';')[0]
    assert.equal((await post(owner, '/api/users', { name: 'mia', password: 'another long password' })).status, 200)
    const signed = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ name: 'mia', password: 'another long password' }) })
    member = signed.headers.get('set-cookie').split(';')[0]
  })
  after(async () => {
    await running.close()
    fs.rmSync(folder, { recursive: true, force: true })
  })

  test('a fresh hub starts with the brain\'s bots, and the settings list presets and models', async () => {
    const settings = await (await get(owner, '/api/bots')).json()
    assert.deepEqual(settings.bots.map(bot => bot.display), ['Echo', 'Parrot'])
    assert.ok(settings.presets.some(preset => preset.id === 'study'))
    assert.deepEqual(settings.models.map(model => model.model), ['echo'])
    assert.equal((await get(member, '/api/bots')).status, 403)
  })

  test('the owner makes a bot from a preset, with a picture, a model, kept off the computers and for the owner only', async () => {
    const uploaded = await post(owner, '/api/bots/picture', PNG, 'image/png')
    assert.equal(uploaded.status, 200)
    const picture = (await uploaded.json()).file.id
    assert.equal((await post(owner, '/api/bots/picture', Buffer.from('#!/bin/sh'), 'text/plain')).status, 415)

    const created = await post(owner, '/api/bots', { display: 'Mochi', description: 'Study buddy', preset: 'study',
      prompt: presetPrompt('study', 'Mochi'), picture, model: { provider: 'echo', model: 'echo' }, computers: false, shared: 'owner' })
    assert.equal(created.status, 200)
    const { bot } = await created.json()
    assert.equal(bot.name, 'mochi')
    assert.match(bot.prompt, /^You are Mochi, a cheerful study buddy/)
    assert.equal(bot.picture, picture)

    // only the owner sees it; the picture is anyone's to load, as a bot's is
    assert.ok(running.hub.bots({ role: 'owner' }).some(item => item.name === 'mochi' && item.picture === picture))
    assert.ok(!running.hub.bots({ role: 'member' }).some(item => item.name === 'mochi'))
    assert.equal((await get(member, `/files/${picture}`)).status, 200)
    // and what a page gets of a bot leaves its personality out
    assert.equal(running.hub.bots({ role: 'owner' }).find(item => item.name === 'mochi').prompt, undefined)

    // refused: a name taken, a model half given, an unknown preset
    assert.match((await (await post(owner, '/api/bots', { display: 'mochi' })).json()).error, /already a bot called/)
    assert.match((await (await post(owner, '/api/bots', { display: 'Kiki', model: { provider: 'echo' } })).json()).error, /Pick a model/)
    assert.match((await (await post(owner, '/api/bots', { display: 'Kiki', preset: 'wizard' })).json()).error, /No such preset/)
  })

  test('a bot kept off the computers gets no computer tools, and changes reach the pages', async () => {
    const page = new WebSocket(base.replace(/^http/, 'ws') + '/ws', { headers: { Cookie: owner, Origin: base } })
    const events = []
    page.on('message', data => events.push(JSON.parse(String(data))))
    await new Promise((resolve, reject) => { page.once('open', resolve); page.once('error', reject) })
    const next = async match => {
      for (let i = 0; i < 200; i++) {
        const found = events.find(match)
        if (found) { events.splice(events.indexOf(found), 1); return found }
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      throw new Error('timed out')
    }
    page.send(JSON.stringify({ type: 'new', conversation: 'chat-mochi', title: 'Study', bots: ['mochi'] }))
    await next(event => event.type === 'conversations')
    page.send(JSON.stringify({ type: 'send', conversation: 'chat-mochi', id: 'm1', text: 'computers' }))
    const answer = await next(event => event.type === 'message' && event.item.speaker === 'Mochi')
    assert.match(answer.item.text, /Only an owner's chats can use the computers/)

    // shared with everyone now: the page hears of it
    assert.equal((await post(owner, '/api/bots/update', { name: 'mochi', shared: 'everyone', description: 'Quizzes you' })).status, 200)
    const told = await next(event => event.type === 'bots')
    assert.equal(told.bots.find(bot => bot.name === 'mochi').description, 'Quizzes you')
    assert.ok(running.hub.bots({ role: 'member' }).some(item => item.name === 'mochi'))
    page.close()
  })

  test('a new picture replaces the old one, whose file goes; removing the bot takes its picture too', async () => {
    const before = running.hub.book.find('mochi').picture
    const fresh = (await (await post(owner, '/api/bots/picture', PNG, 'image/png')).json()).file.id
    assert.equal((await post(owner, '/api/bots/update', { name: 'mochi', picture: fresh })).status, 200)
    assert.equal(running.store.file(before), null)
    assert.equal(fs.existsSync(running.store.filePath(before)), false)
    assert.equal((await post(owner, '/api/bots/remove', { name: 'mochi' })).status, 200)
    assert.equal(running.hub.book.find('mochi'), null)
    assert.equal(running.store.file(fresh), null)
  })
})

test('the config\'s bots are shown as locked: only their picture changes on the page, and no starters are added', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hub-bots-locked-'))
  const running = await quietHub({ folder, bots: [{ name: 'translator', display: 'Translator', prompt: 'You translate.' }] })
  const book = running.hub.book
  assert.deepEqual(book.list().map(bot => [bot.display, bot.locked]), [['Translator', true]])
  assert.match(book.update('translator', { prompt: 'Something else' }).error, /set in the hub's config/)
  assert.match(book.remove('translator').error, /set in the hub's config/)
  const picture = running.store.addFile({ id: 'f' + '1'.repeat(20), name: 'face.png', mime: 'image/png', size: PNG.length, origin: 'bot-picture' }).id
  assert.equal(book.update('translator', { picture }).bot.picture, picture)
  await running.close()
  // a restart keeps it: still no starters, the picture still worn
  const again = await quietHub({ folder, bots: [{ name: 'translator', display: 'Translator' }] })
  assert.deepEqual(again.hub.book.list().map(bot => [bot.display, bot.picture]), [['Translator', picture]])
  await again.close()
  fs.rmSync(folder, { recursive: true, force: true })
})
