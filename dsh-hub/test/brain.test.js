// The DSH brain against a stand-in for DSH: the calls and events its source documents (agents.create/resume,
// followup, agent/assistant-stream, session/event, approval/request). This checks the plugin's own wiring; the real
// DSH is checked by running it (README: Trying it with DSH).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { dshBrain } from '../plugin/brain.js'
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
          if (text.includes('computers')) {
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
    sessions.add(sessionId)
    return { agent: makeAgent(sessionId, agentOptions, tools), dispose: async () => {} }
  }
  const ctx = {
    on, emit, calls, sessions,
    agentPresets: { register: async preset => { calls.preset = preset; return async () => {} }, mount: async (agentCtx, id) => { calls.mounted.push(id) } },
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
  const brain = await dshBrain(ctx, { title: 'Hub', workspace, createUserMessage, toolDefinitions: [],
    bots: [{ name: 'deepseek', display: 'DeepSeek' }, { name: 'whale', display: 'Whale' }] })
  assert.match(ctx.calls.preset.plugins[0].config.prefix, /Also in this chat: DeepSeek/)
  await brain.reply({ chat: { id: 'g', title: 'g', state: {}, bots: null }, bot: 'whale',
    message: { text: '@Whale what do you think?', sender: 'leo', files: [] },
    context: [{ who: 'leo', text: 'upscale this video' }, { who: 'DeepSeek', text: 'Whale has the GPU.' }],
    tools: [], sink: sink(), signal: new AbortController().signal, user: { name: 'leo', role: 'owner' }, save: () => {} })
  const text = ctx.calls.messages[0].content[0].text
  assert.match(text, /\[Said in this chat since you last spoke\]\nleo: upscale this video\nDeepSeek: Whale has the GPU\./)
  assert.match(text, /\[Now, leo\]\n@Whale what do you think\?/)
  fs.rmSync(workspace, { recursive: true, force: true })
})
