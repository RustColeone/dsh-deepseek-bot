// The DSH brain against a stand-in for DSH: the calls and events its source documents (agents.create/resume,
// followup, agent/assistant-stream, session/event, approval/request). This checks the plugin's own wiring; the real
// DSH is checked by running it (README: Trying it with DSH).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { STARTERS, dshBrain } from '../plugin/brain.js'
import { nodeBrain } from '../plugin/node-brain.js'
import { computerTools } from '../lib/tools.js'

function fakeDsh () {
  const listeners = new Map()
  const sessions = new Set()
  const calls = { create: 0, resume: 0, mounted: [], cancelled: 0, messages: [] }
  const on = (name, fn) => { listeners.set(name, [...(listeners.get(name) || []), fn]); return () => {} }
  const emit = (name, ...args) => (listeners.get(name) || []).map(fn => fn(...args))
  const makeAgent = (sessionId, agentOptions, tools) => {
    const session = { id: sessionId }
    const agent = {
      id: `agent-${sessionId}`, session, model: { current: () => agentOptions },
      cancel () { calls.cancelled++; this.stopped = true },
      followup (message) {
        calls.messages.push(message)
        const text = message.content[0].text
        setTimeout(async () => {
          emit('agent/assistant-stream', { agent, frame: { type: 'start' } })
          if (text.includes('slow')) {
            await new Promise(resolve => setTimeout(resolve, 200))
            if (agent.stopped) { emit('session/event', session, { type: 'turn/end', data: { reason: { kind: 'aborted' } } }); return }
          }
          if (text.includes('post a file')) {
            const value = await tools.get('chat_send_file').execute({ path: 'C:/out/result.mp4' }, { agent, signal: new AbortController().signal })
            const said = `Posted ${value.name}.`
            emit('session/event', session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: said }] } } })
          } else if (text.includes('computers')) {
            emit('session/event', session, { type: 'tool/call', data: { callId: 'c1', name: 'computers_list', arguments: '{}' } })
            const value = await tools.get('computers_list').execute({}, { agent, signal: new AbortController().signal })
            emit('session/event', session, { type: 'tool/result', data: { message: { content: JSON.stringify(value) } } })
            emit('agent/assistant-stream', { agent, frame: { type: 'start' } })
            const said = `You have ${value.computers.length} computers.`
            emit('agent/assistant-stream', { agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text: said } } })
            emit('session/event', session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: said }] } } })
          } else {
            for (const part of ['Hello ', 'from DSH']) emit('agent/assistant-stream', { agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text: part } } })
            emit('session/event', session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Hello from DSH' }] } } })
          }
          emit('session/event', session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
        }, 5)
      },
    }
    return agent
  }
  const build = async (sessionId, agentOptions, setup) => {
    const tools = new Map()
    // As strict as DSH: an output schema of a type it knows, and results that are lossless JSON
    const strict = def => {
      if (!['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(def.output?.schema?.type)) {
        throw new Error(`unsupported JSON schema for ${def.name}`)
      }
      const execute = def.execute
      return { ...def, async execute (...args) {
        const value = await execute(...args)
        if (JSON.stringify(value) !== JSON.stringify(JSON.parse(JSON.stringify(value))) || /undefined/.test(JSON.stringify(value, (key, item) => item === undefined ? 'undefined' : item))) {
          throw new Error(`${def.name}: value is not lossless JSON`)
        }
        return value
      } }
    }
    const agentCtx = { tools: { register: def => { tools.set(def.name, strict(def)); return () => {} } } }
    await setup(agentCtx)
    calls.tools = [...tools.keys()]
    sessions.add(sessionId)
    return { agent: makeAgent(sessionId, agentOptions, tools), dispose: async () => {} }
  }
  const ctx = {
    on, emit, calls, sessions,
    agentPresets: { register: async preset => { calls.preset = preset; (calls.presets ??= []).push(preset); return async () => { calls.unregistered = (calls.unregistered || 0) + 1 } }, mount: async (agentCtx, id) => { calls.mounted.push(id) } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) },
    sessionQuery: {
      observeSession: async id => {
        if (!sessions.has(id)) { const error = new Error('not found'); error.code = 'SESSION_QUERY_SESSION_NOT_FOUND'; throw error }
        return { [Symbol.dispose] () {} }
      },
    },
    agents: {
      create: async ({ sessionId, agentOptions, setup }) => { calls.create++; return build(sessionId, agentOptions, setup) },
      resume: async ({ resumeSessionId, agentOptions, setup }) => { calls.resume++; return build(resumeSessionId, agentOptions, setup) },
    },
  }
  return ctx
}

const createUserMessage = message => ({ role: 'user', ...message })
const sink = () => ({ streamed: [], activities: [], stream (text) { this.streamed.push(text) }, activity (line) { this.activities.push(line) } })

test('a chat gets an agent once, its replies stream, and its tools reach the hub', async () => {
  const ctx = fakeDsh()
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hub-brain-'))
  const options = { title: 'Hub', workspace, createUserMessage,
    toolDefinitions: computerTools(null).map(({ name, description, parameters }) => ({ name, description, parameters })) }
  const brain = await dshBrain(ctx, options)
  await brain.sync(STARTERS)
  assert.deepEqual(brain.bots().map(bot => bot.display), ['DeepSeek'])
  assert.equal(ctx.calls.preset.id, 'dsh-hub-deepseek')
  assert.match(ctx.calls.preset.plugins[0].config.prefix, /This is a chat, not a coding session/)

  const chat = { id: 'chat-1', title: 'First chat', state: {} }
  let saved = null
  const save = state => { saved = state }
  const owner = { name: 'leo', role: 'owner' }
  const first = sink()
  const answer = await brain.reply({ chat, bot: 'deepseek', message: { text: 'hi', sender: 'leo', files: [] }, context: [],
    tools: [], sink: first, signal: new AbortController().signal, user: owner, save })
  assert.equal(answer.text, 'Hello from DSH')
  assert.equal(answer.data.model, 'deepseek-flash')
  assert.deepEqual(first.streamed, ['Hello ', 'Hello from DSH'])
  assert.match(saved.sessions.deepseek, /^hub-/)
  assert.equal(ctx.calls.messages[0].source.kind, 'user')
  assert.deepEqual(ctx.calls.mounted, ['dsh-hub-deepseek'])

  // The hub's tools for this turn are what the agent's tool runs.
  const tools = [{ name: 'computers_list', run: async () => ({ computers: [{ name: 'ROG' }, { name: 'Pi' }] }) }]
  const second = sink()
  const counted = await brain.reply({ chat, bot: 'deepseek', message: { text: 'list my computers', sender: 'leo', files: [] },
    context: [], tools, sink: second, signal: new AbortController().signal, user: owner, save })
  assert.equal(counted.text, 'You have 2 computers.')
  assert.ok(second.activities.includes('looking at the computers'))
  assert.equal(ctx.calls.create, 1) // the same agent both times

  // After a restart the chat's session is resumed, not made again.
  const again = await dshBrain(ctx, options)
  again.sync(STARTERS)
  await again.reply({ chat, bot: 'deepseek', message: { text: 'hi again', sender: 'leo', files: [] }, context: [],
    tools: [], sink: sink(), signal: new AbortController().signal, user: owner, save })
  assert.equal(ctx.calls.resume, 1)
  assert.equal(ctx.calls.create, 1)
  fs.rmSync(workspace, { recursive: true, force: true })
})

test('stopping a reply cancels the agent\'s turn', async () => {
  const ctx = fakeDsh()
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hub-brain-'))
  const brain = await dshBrain(ctx, { title: 'Hub', workspace, createUserMessage, toolDefinitions: [] })
  brain.sync(STARTERS)
  const controller = new AbortController()
  const reply = brain.reply({ chat: { id: 'c', title: 'c', state: {} }, bot: 'deepseek', message: { text: 'slow one', sender: 'leo', files: [] },
    context: [], tools: [], sink: sink(), signal: controller.signal, user: { name: 'leo', role: 'owner' }, save: () => {} })
  setTimeout(() => controller.abort(), 50)
  await assert.rejects(reply, /stopped/)
  assert.equal(ctx.calls.cancelled, 1)
  fs.rmSync(workspace, { recursive: true, force: true })
})

test('a group chat tells the bot what others said since it last spoke', async () => {
  const ctx = fakeDsh()
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hub-brain-'))
  const brain = await dshBrain(ctx, { title: 'Hub', workspace, createUserMessage, toolDefinitions: [] })
  await brain.sync([{ name: 'deepseek', display: 'DeepSeek' }, { name: 'whale', display: 'Whale' }])
  // a bot's persona is its own: who else is in a chat comes with each message
  assert.doesNotMatch(ctx.calls.preset.plugins[0].config.prefix, /DeepSeek/)
  await brain.reply({ chat: { id: 'g', title: 'g', state: {}, bots: null }, bot: 'whale', others: ['DeepSeek'],
    message: { text: '@Whale what do you think?', sender: 'leo', files: [] },
    context: [{ who: 'leo', text: 'upscale this video' }, { who: 'DeepSeek', text: 'Whale has the GPU.' }],
    tools: [], sink: sink(), signal: new AbortController().signal, user: { name: 'leo', role: 'owner' }, save: () => {} })
  const text = ctx.calls.messages[0].content[0].text
  assert.match(text, /\[Said in this chat since you last spoke\]\nleo: upscale this video\nDeepSeek: Whale has the GPU\./)
  assert.match(text, /\[Now, leo\]\n@Whale what do you think\?/)
  assert.match(text, /^\[Also in this chat: DeepSeek\]/)
  fs.rmSync(workspace, { recursive: true, force: true })
})

test('a bot thinks with its own model, may be kept off the computers, and an edit reaches its next answer', async () => {
  const ctx = fakeDsh()
  ctx.llm = {
    listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek API' }, { id: 'agy', name: 'Antigravity' }],
    listModels: async provider => provider === 'agy' ? [{ provider, id: 'gemini-3-pro', name: 'Gemini 3 Pro' }] : [{ provider, id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }],
  }
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hub-brain-'))
  const toolDefinitions = computerTools(null).map(({ name, description, parameters }) => ({ name, description, parameters }))
  const brain = await dshBrain(ctx, { title: 'Hub', workspace, createUserMessage, toolDefinitions })
  assert.deepEqual((await brain.models()).map(item => `${item.providerName}: ${item.name}`), ['DeepSeek API: DeepSeek V4 Pro', 'Antigravity: Gemini 3 Pro'])

  const mochi = { name: 'mochi', display: 'Mochi', prompt: 'You are Mochi, a study buddy.', model: { provider: 'agy', model: 'gemini-3-pro' }, computers: false }
  await brain.sync([mochi])
  const prefix = () => ctx.calls.presets.at(-1).plugins[0].config.prefix
  assert.match(prefix(), /^You are Mochi, a study buddy\./)
  assert.doesNotMatch(prefix(), /computers_list/)
  const chat = { id: 'c', title: 'Study', state: {} }
  const ask = text => brain.reply({ chat, bot: 'mochi', message: { text, sender: 'leo', files: [] }, context: [],
    tools: [{ name: 'computers_list', run: async () => ({ computers: [] }) }], sink: sink(), signal: new AbortController().signal,
    user: { name: 'leo', role: 'owner' }, save: state => { chat.state = state } })
  const first = await ask('hi')
  assert.equal(first.data.model, 'gemini-3-pro')
  // kept off the computers: its agent has no computer tools at all
  assert.deepEqual(ctx.calls.tools, [])

  // edited: a fresh preset, and its live agent let go, so the next answer resumes with what it is now
  const registered = ctx.calls.presets.length
  await brain.sync([{ ...mochi, prompt: 'You are Mochi, now very formal.', model: null, computers: true }])
  assert.equal(ctx.calls.presets.length, registered + 1)
  assert.match(prefix(), /now very formal/)
  assert.match(prefix(), /computers_list/)
  const second = await ask('hi again')
  assert.equal(second.data.model, 'deepseek-flash') // DSH's default now
  assert.ok(ctx.calls.tools.includes('computers_list'))
  assert.equal(ctx.calls.resume, 1)
  // the same again changes nothing
  await brain.sync([{ ...mochi, prompt: 'You are Mochi, now very formal.', model: null, computers: true }])
  assert.equal(ctx.calls.presets.length, registered + 1)
  // removed: its preset goes, and it no longer answers
  await brain.sync([])
  await assert.rejects(ask('still there?'), /no longer on the hub/)
  fs.rmSync(workspace, { recursive: true, force: true })
})

test("a node's own agents: its bots (kept across restarts), tasks, and posting files to the chat", async () => {
  const ctx = fakeDsh()
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hub-node-brain-'))
  const options = { folder, inbox: path.join(folder, 'inbox'), createUserMessage, permission: 'workspace-write',
    bots: [{ display: 'ROG', description: 'the gaming PC' }] }
  const brain = await nodeBrain(ctx, options)
  assert.deepEqual(ctx.calls.presets.map(preset => preset.id), ['dsh-hub-task', 'dsh-hub-node-rog'])
  const rogPreset = ctx.calls.presets[1]
  assert.match(rogPreset.plugins[0].config.prefix, /You live on .*, one of the owner's computers/)
  assert.ok(rogPreset.plugins.some(plugin => plugin.name === (process.platform === 'win32' ? '@deepseek-ai/dsh-tool-pwsh' : '@deepseek-ai/dsh-tool-bash')))

  const bot = await brain.create({ display: 'Pi Bot', description: 'small', prompt: 'You are tiny.' })
  assert.equal(bot.name, 'pi-bot')
  assert.deepEqual(brain.bots().map(item => item.name), ['rog', 'pi-bot'])
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder, 'bots.json'), 'utf8')).map(item => item.name), ['pi-bot'])

  const posted = []
  const run = (mode, text, session) => brain.run({ mode, bot: 'rog', session, text, sink: sink(), signal: new AbortController().signal,
    approve: async () => 'approved', postFile: async where => { posted.push(where); return { file: { name: 'result.mp4' }, size: 3 } } })
  const reply = await run('reply', 'hello')
  assert.equal(reply.text, 'Hello from DSH')
  assert.match(reply.session, /^hub-bot-/)
  assert.equal((await run('reply', 'again', reply.session)).session, reply.session)
  assert.equal(ctx.calls.create, 1)
  const task = await run('task', 'please post a file')
  assert.match(task.session, /^hub-task-/)
  assert.equal(task.text, 'Posted result.mp4.')
  assert.deepEqual(posted, ['C:/out/result.mp4'])
  assert.ok(ctx.calls.mounted.includes('dsh-hub-task'))
  await assert.rejects(brain.run({ mode: 'reply', bot: 'nobody', text: 'x', sink: sink() }), /no bot nobody/)

  // Restarted, it still has the bot the owner added; removing it unregisters its preset.
  const again = await nodeBrain(ctx, options)
  assert.deepEqual(again.bots().map(item => item.display), ['ROG', 'Pi Bot'])
  await again.remove('pi-bot')
  assert.deepEqual(again.bots().map(item => item.name), ['rog'])
  await assert.rejects(again.remove('rog'), /own config/)
  fs.rmSync(folder, { recursive: true, force: true })
})
