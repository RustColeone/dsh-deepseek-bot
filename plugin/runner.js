// DSH agents for the hub's plugin, on the hub and on a node alike: make or resume an agent for a session, run one turn
// of it (stream its text and say what it is doing), and route DSH's approval requests for it to whoever started the
// turn. brain.js (the hub's bots) and node-brain.js (a computer's own bots and the agents it does tasks with) are both
// made of this.
//
// A turn: the message goes in with agent.followup(); the reply streams back from `agent/assistant-stream` (text deltas;
// a tool call's name becomes "running a command…"); the turn is over at the session's `turn/end`, and the reply is the
// last assistant message's text. Stopping cancels the agent's turn.
import crypto from 'node:crypto'
import { activity as hubActivity } from '../lib/tools.js'

const textOf = message => (message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('')

function prettyJson (text) {
  try { return JSON.stringify(JSON.parse(text), null, 2) } catch { return String(text) }
}

/** What a DSH tool call is doing, for the page: the hub's own tools by name, DSH's by their usual arguments. */
export function activity (name, args = {}) {
  if (/^(computer|computers)_/.test(name)) return hubActivity(name, args)
  if (name === 'chat_send_file') return 'sending a file to the chat'
  const command = args.command || args.script
  if (command) return `running ${String(command).split(/\s+/).slice(0, 4).join(' ').slice(0, 60)}`
  const where = args.path || args.file_path || args.pattern || args.url || args.query
  return where ? `${name.replace(/_/g, ' ')} ${String(where).slice(0, 60)}` : `using ${name}`
}

/**
 * @param ctx the plugin's context, with agents, agentPresets, approval, sessionQuery, agentDefaultModel
 * @param options { createUserMessage, model: { provider, model }, log }
 */
export async function agentRunner (ctx, options = {}) {
  const log = options.log ?? (() => {})
  const createUserMessage = options.createUserMessage ?? (await import('@deepseek-ai/dsh-llm')).createUserMessage
  const live = new Map() // session id -> agent
  const handles = new Map() // session id -> the AgentHandle that can dispose it
  const current = new Map() // agent id -> the turn it is in: { tools, sink, approve, calls, text, last, done }
  const model = () => options.model?.provider ? { ...options.model } : { ...ctx.agentDefaultModel.currentSelection() }

  /** A hub tool (plain JSON-Schema parameters, run(args, signal)) as a DSH tool, run through the turn's own tools. */
  function dshTool (tool) {
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
        const own = turn?.tools?.find(item => item.name === tool.name)
        if (!own) throw new Error('This tool is only available in a turn started from the hub.')
        // DSH keeps tool results as strict JSON: no undefined fields, no class instances
        return JSON.parse(JSON.stringify(await own.run(args ?? {}, exec.signal) ?? {}))
      },
    }
  }

  /** The setup an agent of `presetId` gets: the preset, and these tools' shapes (run per turn). */
  const setup = (presetId, toolDefinitions = []) => async agentCtx => {
    await ctx.agentPresets.mount(agentCtx, presetId)
    for (const tool of toolDefinitions) agentCtx.tools.register(dshTool(tool))
  }

  /**
   * The agent of a session: the live one, else resumed, else a new session (`prefix`-uuid). Returns { agent, sessionId }.
   * `title` names a new session in DSH's own list of sessions.
   */
  async function agentFor ({ sessionId, prefix = 'hub', presetId, toolDefinitions, cwd, permission, title }) {
    if (sessionId && live.has(sessionId)) return { agent: live.get(sessionId), sessionId }
    if (sessionId) {
      try {
        const found = await ctx.sessionQuery.observeSession(sessionId)
        found[Symbol.dispose]?.()
        const handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: model(), setup: await setup(presetId, toolDefinitions) })
        live.set(sessionId, handle.agent)
        handles.set(sessionId, handle)
        return { agent: handle.agent, sessionId }
      } catch (error) {
        if (error?.code !== 'SESSION_QUERY_SESSION_NOT_FOUND') log('resume_failed', { session: sessionId, error: String(error?.message || error) })
      }
    }
    const fresh = `${prefix}-${crypto.randomUUID()}`
    const handle = await ctx.agents.create({
      sessionId: fresh, meta: { cwd, agentPreset: presetId }, agentOptions: model(), setup: await setup(presetId, toolDefinitions),
    })
    try { if (permission) ctx.permissionPresets?.set(handle.agent.session, permission) } catch (error) {
      log('permission_preset_failed', { error: String(error?.message || error) })
    }
    try { if (title) ctx.get?.('sessionTitle')?.rename(handle.agent.session, title) } catch { /* optional */ }
    live.set(fresh, handle.agent)
    handles.set(fresh, handle)
    return { agent: handle.agent, sessionId: fresh }
  }

  /**
   * One turn: send `text`, stream into `sink` (stream(text so far), activity(line)), resolve with the reply's text.
   * `approve({ tool, summary, detail, signal })` answers DSH's approval requests: 'approved', 'denied', 'cancelled'.
   */
  async function turn ({ agent, text, source = { kind: 'user' }, sink, signal, tools = [], approve, busy = 'still busy' }) {
    if (current.has(agent.id)) throw new Error(busy)
    const finished = new Promise((resolve, reject) => {
      const record = { agent, tools, sink, approve, text: '', last: '', calls: new Map(),
        done: reason => {
          current.delete(agent.id)
          signal?.removeEventListener('abort', stop)
          if (reason?.kind === 'error') reject(new Error('the model call failed'))
          else if (reason?.kind === 'aborted' || reason?.kind === 'interrupted') reject(new Error('stopped'))
          else resolve(record.last || record.text)
        } }
      const stop = () => { try { agent.cancel('stopped from the hub') } catch { /* already idle */ } }
      signal?.addEventListener('abort', stop, { once: true })
      current.set(agent.id, record)
    })
    try {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source }))
    } catch (error) {
      current.delete(agent.id)
      throw error
    }
    return await finished
  }

  // ---- what DSH says while a turn runs
  const offs = []
  offs.push(ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const record = current.get(agent?.id)
    if (!record) return
    if (frame.type === 'start') { record.text = ''; return }
    if (frame.type !== 'chunk') return
    const chunk = frame.chunk
    if (chunk.type === 'text-delta') { record.text += chunk.text; record.sink.stream(record.text) }
    else if (chunk.type === 'reasoning-delta' && !record.text) record.sink.activity('thinking…')
    else if (chunk.type === 'tool-call-delta' && chunk.name) record.sink.activity(activity(chunk.name))
  }))
  offs.push(ctx.on('session/event', (session, event) => {
    for (const record of current.values()) {
      if (record.agent.session !== session && record.agent.session?.id !== session?.id) continue
      if (event.type === 'tool/call') {
        record.calls.set(event.data.callId, { name: event.data.name, arguments: event.data.arguments })
        let args = {}
        try { args = JSON.parse(event.data.arguments || '{}') } catch { /* partial */ }
        record.sink.activity(activity(event.data.name, args))
      } else if (event.type === 'assistant/message') {
        const said = textOf(event.data.message)
        if (said.trim()) record.last = said
      } else if (event.type === 'turn/end') {
        record.done(event.data.reason)
      }
    }
  }))
  // DSH asks about a tool for one of these agents: whoever started the turn answers.
  offs.push(ctx.on('approval/request', async (request, next) => {
    const record = current.get(request.agent?.id)
    if (!record?.approve) return next()
    const call = request.callId ? record.calls.get(request.callId) : null
    const decision = await record.approve({
      tool: request.toolName, signal: request.signal,
      summary: request.displayReason?.en || request.reason || `use ${request.toolName}`,
      detail: call?.arguments ? prettyJson(call.arguments) : '',
    })
    return decision === 'approved' || decision === 'always' ? 'allowed-once' : decision === 'cancelled' ? 'cancelled' : 'rejected'
  }, { prepend: true }))

  return {
    agentFor,
    turn,
    busy: agent => current.has(agent.id),
    async forget (sessionId) {
      const handle = handles.get(sessionId)
      live.delete(sessionId)
      handles.delete(sessionId)
      try { await handle?.dispose() } catch (error) { log('dispose_failed', { session: sessionId, error: String(error?.message || error) }) }
    },
    close () { for (const off of offs) { try { off?.() } catch { /* unloading */ } } },
  }
}
