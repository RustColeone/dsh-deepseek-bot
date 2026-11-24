// The hub's brain inside DeepSeek Harness: each bot of each chat is a DSH agent with a session of its own, kept across
// restarts (the chat remembers its session ids). A bot is chatty, not a coding agent: its agent preset is the bot's
// persona as the whole system prompt, the time, compaction, and the hub's computer tools, with no workspace tools.
//
// A turn: the message goes in with agent.followup(); the reply streams back from `agent/assistant-stream` (text deltas;
// a tool call's name becomes the page's "running a command on ROG…"); the turn is over at the session's `turn/end`,
// and the reply is the last assistant message's text. A DSH approval for one of these agents (a tool DSH itself asks
// about) becomes an approval card in the chat. Stopping a reply cancels the agent's turn.
import crypto from 'node:crypto'
import fs from 'node:fs'
import { activity } from '../lib/tools.js'

const PRESET = 'dsh-hub-'

export const DEFAULT_BOTS = [
  { name: 'deepseek', display: 'DeepSeek', description: 'Your assistant on the hub.' },
]

function persona (bot, bots, title) {
  const others = bots.filter(other => other.name !== bot.name).map(other => other.display)
  return [
    bot.prompt || `You are ${bot.display}, an assistant people chat with in ${title}, a chat app that runs on their own computers.`,
    '',
    'This is a chat, not a coding session: answer like a person in a messaging app, naturally and briefly (a few ' +
    'sentences unless more is asked for), in the language you are written to. Use Markdown only when it helps.',
    '',
    'You can use the owner\'s computers that have joined this hub: computers_list shows them (online or not, their ' +
    'system, GPUs and tools); computer_run runs a command on one (PowerShell on Windows, bash elsewhere), and the owner ' +
    'may be asked to approve it first; computer_job follows a long job and computer_job_cancel stops it. Pick the ' +
    'computer by what the task needs (a GPU for video work, say). For long work, start it with a short wait, tell the ' +
    'owner it is running and where, and check on it when asked. Files people attach are kept on the hub, each with a ' +
    'file id: computer_send_file copies one to a computer (and says its path there), and computer_get_file brings a ' +
    'file from a computer back into this chat, where the owner can open it. So for "upscale this video on my PC": ' +
    'send it, run the tool on it there, then get the result back. Never say you ran or saw something you did not.',
    ...(others.length ? ['', `Also in this chat: ${others.join(', ')}. When a message is for one of them, or a part of ` +
      'the work suits them better, say so and @mention them: they answer next. Messages from others appear as ' +
      '"Name: text".'] : []),
  ].join('\n')
}

/** A hub tool (lib/tools.js: JSON-Schema parameters) as a DSH tool definition, run through the turn's own tools. */
function toDshTool (tool, current) {
  const parameters = {}
  const required = new Set(tool.parameters.required || [])
  for (const [key, spec] of Object.entries(tool.parameters.properties || {})) {
    parameters[key] = { type: spec.type, ...(spec.enum ? { enum: spec.enum } : {}), ...(spec.description ? { description: spec.description } : {}),
      ...(required.has(key) ? { required: true } : {}) }
  }
  return {
    name: tool.name,
    description: tool.description,
    parameters,
    output: {
      schema: { type: 'object' }, // every hub tool answers with an object; its fields vary
      render: (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute (args, exec) {
      const turn = current.get(exec.agent?.id)
      const own = turn?.tools.find(item => item.name === tool.name)
      if (!own) throw new Error('This tool is only available in the owner\'s chats on the hub.')
      // DSH keeps tool results as strict JSON: no undefined fields, no class instances
      return JSON.parse(JSON.stringify(await own.run(args ?? {}, exec.signal) ?? {}))
    },
  }
}

const textOf = message => (message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('')

/**
 * @param ctx the plugin's context, with agents, agentPresets, tools, approval, sessionQuery, agentDefaultModel
 * @param options { bots, title, workspace, model: { provider, model, reasoningEffort }, permission, toolDefinitions,
 *   createUserMessage, log }
 */
export async function dshBrain (ctx, options) {
  const bots = (options.bots?.length ? options.bots : DEFAULT_BOTS).map(bot => ({
    name: String(bot.name), display: String(bot.display || bot.name), description: String(bot.description || ''), prompt: bot.prompt || '',
  }))
  const log = options.log ?? (() => {})
  // DSH's message constructor; handed in by index.js (and by the tests, which run without DSH)
  const createUserMessage = options.createUserMessage ?? (await import('@deepseek-ai/dsh-llm')).createUserMessage
  const workspace = options.workspace
  fs.mkdirSync(workspace, { recursive: true })
  const live = new Map() // session id -> agent
  const handles = new Map() // session id -> the AgentHandle that can dispose it
  const current = new Map() // agent id -> { tools, sink, text, done, chat, bot }
  let hub = null // set by attach(): approval cards

  // ---- one preset per bot: its persona, the time, compaction, and nothing of DSH's workspace tools
  const offs = []
  for (const bot of bots) {
    offs.push(await ctx.agentPresets.register({
      id: PRESET + bot.name, name: `${bot.display} (hub)`, description: `${bot.display} on the hub's chat page`, order: 90,
      plugins: [
        { id: 'persona', name: '@deepseek-ai/dsh-persona',
          config: { prefix: persona(bot, bots, options.title), complete: true, includeRuntimeContext: false } },
        { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
        { id: 'compaction', name: 'cordis:group', group: true, isolate: { compaction: true }, config: [
          { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
          { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
        ] },
      ],
    }))
  }
  const hubTools = options.toolDefinitions // the shapes of lib/tools.js's tools, for registering once per agent

  const model = () => options.model?.provider ? { ...options.model } : { ...ctx.agentDefaultModel.currentSelection() }
  const setup = presetId => async agentCtx => {
    await ctx.agentPresets.mount(agentCtx, presetId)
    for (const tool of hubTools) agentCtx.tools.register(toDshTool(tool, current))
  }

  async function agentFor (chat, bot, save) {
    const sessions = { ...(chat.state.sessions || {}) }
    const known = sessions[bot.name]
    if (known && live.has(known)) return live.get(known)
    const presetId = PRESET + bot.name
    if (known) {
      try {
        const found = await ctx.sessionQuery.observeSession(known)
        found[Symbol.dispose]?.()
        const handle = await ctx.agents.resume({ resumeSessionId: known, agentOptions: model(), setup: await setup(presetId) })
        live.set(known, handle.agent)
        handles.set(known, handle)
        return handle.agent
      } catch (error) {
        if (error?.code !== 'SESSION_QUERY_SESSION_NOT_FOUND') log('resume_failed', { session: known, error: String(error?.message || error) })
      }
    }
    const sessionId = `hub-${crypto.randomUUID()}`
    const handle = await ctx.agents.create({
      sessionId, meta: { cwd: workspace, agentPreset: presetId }, agentOptions: model(), setup: await setup(presetId),
    })
    try { if (options.permission) ctx.permissionPresets?.set(handle.agent.session, options.permission) } catch (error) {
      log('permission_preset_failed', { error: String(error?.message || error) })
    }
    try { ctx.get?.('sessionTitle')?.rename(handle.agent.session, `${chat.title} · ${bot.display}`) } catch { /* optional */ }
    sessions[bot.name] = sessionId
    chat.state = { ...chat.state, sessions }
    save(chat.state)
    live.set(sessionId, handle.agent)
    handles.set(sessionId, handle)
    return handle.agent
  }

  // ---- what DSH says while a turn runs
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const turn = current.get(agent?.id)
    if (!turn) return
    if (frame.type === 'start') { turn.text = ''; return }
    if (frame.type !== 'chunk') return
    const chunk = frame.chunk
    if (chunk.type === 'text-delta') { turn.text += chunk.text; turn.sink.stream(turn.text) }
    else if (chunk.type === 'reasoning-delta' && !turn.text) turn.sink.activity('thinking…')
    else if (chunk.type === 'tool-call-delta' && chunk.name) turn.sink.activity(activity(chunk.name))
  })
  ctx.on('session/event', (session, event) => {
    for (const turn of current.values()) {
      if (turn.agent.session !== session && turn.agent.session?.id !== session?.id) continue
      if (event.type === 'tool/call') {
        turn.calls.set(event.data.callId, { name: event.data.name, arguments: event.data.arguments })
        let args = {}
        try { args = JSON.parse(event.data.arguments || '{}') } catch { /* partial */ }
        turn.sink.activity(activity(event.data.name, args))
      } else if (event.type === 'assistant/message') {
        const text = textOf(event.data.message)
        if (text.trim()) turn.last = text
      } else if (event.type === 'turn/end') {
        turn.done(event.data.reason)
      }
    }
  })
  // DSH asks about one of its own tools for one of our agents: the owner answers on the page.
  ctx.on('approval/request', async (request, next) => {
    const turn = current.get(request.agent?.id)
    if (!turn || !hub) return next()
    const call = request.callId ? turn.calls.get(request.callId) : null
    const decision = await hub.ask({
      chat: turn.chat, user: turn.user, bot: turn.botDisplay, signal: request.signal,
      title: `May ${turn.botDisplay} use ${request.toolName}?`,
      summary: request.displayReason?.en || request.reason || `${turn.botDisplay} wants to use ${request.toolName}.`,
      detail: call?.arguments ? prettyJson(call.arguments) : '',
    })
    return decision === 'approved' || decision === 'always' ? 'allowed-once' : decision === 'cancelled' ? 'cancelled' : 'rejected'
  }, { prepend: true })

  return {
    attach (theHub) { hub = theHub },
    bots: () => bots.map(({ name, display, description }) => ({ name, display, description })),

    async reply ({ chat, bot: name, message, context, tools, sink, signal, user, save }) {
      const bot = bots.find(item => item.name === name)
      const agent = await agentFor(chat, bot, save)
      if (current.has(agent.id)) throw new Error(`${bot.display} is still busy with the last message.`)
      let text = message.text
      if (context.length) {
        text = `[Said in this chat since you last spoke]\n${context.map(line => `${line.who}: ${line.text}`).join('\n')}\n\n` +
          `[Now, ${message.sender}]\n${text}`
      } else if (bots.length > 1 && chat.bots?.length !== 1) {
        text = `${message.sender}: ${text}`
      }
      for (const file of message.files || []) {
        text += `\n[Attached: ${file.name} (${file.mime}, ${Math.max(1, Math.round(file.size / 1024))} KB), hub file id ${file.id}]`
      }
      const finished = new Promise((resolve, reject) => {
        const turn = { agent, tools, sink, text: '', last: '', calls: new Map(), chat, user, botDisplay: bot.display,
          done: reason => {
            current.delete(agent.id)
            signal.removeEventListener('abort', stop)
            if (reason?.kind === 'error') reject(new Error('the model call failed'))
            else if (reason?.kind === 'aborted' || reason?.kind === 'interrupted') reject(new Error('stopped'))
            else resolve(turn.last || turn.text)
          } }
        const stop = () => { try { agent.cancel('stopped from the hub page') } catch { /* already idle */ } }
        signal.addEventListener('abort', stop, { once: true })
        current.set(agent.id, turn)
      })
      try {
        agent.followup(createUserMessage({
          content: [{ type: 'text', text }],
          source: user.role === 'owner' ? { kind: 'user' } : { kind: 'dsh-hub', chat: chat.id, sender: message.sender },
        }))
      } catch (error) {
        current.delete(agent.id)
        throw error
      }
      const reply = await finished
      const selection = agent.model?.current?.()
      return { text: reply, data: selection ? { provider: selection.provider, model: selection.model } : {} }
    },

    async forget (chat) {
      for (const sessionId of Object.values(chat.state.sessions || {})) {
        const handle = handles.get(sessionId)
        live.delete(sessionId)
        handles.delete(sessionId)
        try { await handle?.dispose() } catch (error) { log('dispose_failed', { session: sessionId, error: String(error?.message || error) }) }
      }
    },

    async close () {
      for (const off of offs) { try { await off() } catch { /* unloading */ } }
    },
  }
}

function prettyJson (text) {
  try { return JSON.stringify(JSON.parse(text), null, 2) } catch { return String(text) }
}
