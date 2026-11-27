// The hub's brain inside DeepSeek Harness: each bot of each chat is a DSH agent with a session of its own, kept across
// restarts (the chat remembers its session ids). A bot is chatty, not a coding agent: its agent preset is the bot's
// persona as the whole system prompt, the time, compaction, and (if it may use them) the hub's computer tools, with no
// workspace tools. It thinks with its own model, or DSH's default.
//
// The bots are the hub's (lib/bots.js); sync() is told whenever they change. A bot whose persona, model or tools
// changed gets a fresh preset, and its live agents are let go, so its next answer (in every chat, whose sessions
// resume) is the new one's. Running the agents is runner.js's; a DSH approval for one of them becomes an approval card.
import fs from 'node:fs'
import { messageText } from '../lib/text.js'
import { agentRunner } from './runner.js'

const PRESET = 'dsh-hub-'

/** A fresh hub's bot, when its config lists none. */
export const STARTERS = [
  { name: 'deepseek', display: 'DeepSeek', description: 'Your assistant on the hub.', preset: 'assistant' },
]

function persona (bot, title) {
  return [
    bot.prompt || `You are ${bot.display}, an assistant people chat with in ${title}, a chat app that runs on their own computers.`,
    '',
    'This is a chat, not a coding session: answer like a person in a messaging app, naturally and briefly (a few ' +
    'sentences unless more is asked for), in the language you are written to. Use Markdown only when it helps.',
    ...(bot.computers === false ? [] : ['',
      'You can use the owner\'s computers that have joined this hub: computers_list shows them (online or not, their ' +
      'system, GPUs, tools, and whether they can take on a task); computer_run runs a command on one (PowerShell on ' +
      'Windows, bash elsewhere), and the owner may be asked to approve it first; computer_job follows a long job and ' +
      'computer_job_cancel stops it. Pick the computer by what the task needs (a GPU for video work, say). For long ' +
      'work, start it with a short wait, tell the owner it is running and where, and check on it when asked. Files ' +
      'people attach are kept on the hub, each with a file id: computer_send_file copies one to a computer (and says ' +
      'its path there), and computer_get_file brings a file from a computer back into this chat, where the owner can ' +
      'open it. So for "upscale this video on my PC": send it, run the tool on it there, then get the result back. For ' +
      'a task of many steps on one computer, computer_delegate hands it to an agent working on that computer itself, ' +
      'which reports back. Never say you ran or saw something you did not.']),
    '',
    'Other bots may share a chat with you; a message then says who else is in it. When a message is for one of them, ' +
    'or a part of the work suits them better, say so and @mention them: they answer next. Messages from others ' +
    'appear as "Name: text".',
  ].join('\n')
}

/**
 * @param ctx the plugin's context, with agents, agentPresets, tools, approval, sessionQuery, agentDefaultModel, llm
 * @param options { title, workspace, model: { provider, model, reasoningEffort } (instead of DSH's default),
 *   permission, toolDefinitions, createUserMessage, log }
 */
export async function dshBrain (ctx, options) {
  const log = options.log ?? (() => {})
  const workspace = options.workspace
  fs.mkdirSync(workspace, { recursive: true })
  const runner = await agentRunner(ctx, { createUserMessage: options.createUserMessage, model: options.model, log })
  let hub = null // set by attach(): approval cards

  const bots = new Map() // name -> the bot, as the hub has it
  const presets = new Map() // name -> { key (what its preset was made from), off () }
  const sessions = new Map() // name -> Set of its sessions this brain has run
  let syncing = Promise.resolve()

  /** One preset per bot: its persona, the time, compaction, and nothing of DSH's workspace tools. */
  const register = bot => ctx.agentPresets.register({
    id: PRESET + bot.name, name: `${bot.display} (hub)`, description: `${bot.display} on the hub's chat page`, order: 90,
    plugins: [
      { id: 'persona', name: '@deepseek-ai/dsh-persona',
        config: { prefix: persona(bot, options.title), complete: true, includeRuntimeContext: false } },
      { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
      { id: 'compaction', name: 'cordis:group', group: true, isolate: { compaction: true }, config: [
        { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
        { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
      ] },
    ],
  })

  /** Let a bot's live agents go: its next turn resumes its sessions with what it is now. */
  async function letGo (name) {
    for (const sessionId of sessions.get(name) ?? []) await runner.forget(sessionId)
  }

  function sync (list) {
    syncing = syncing.then(async () => {
      const wanted = new Map(list.map(bot => [bot.name, bot]))
      for (const [name, made] of presets) {
        if (wanted.has(name)) continue
        presets.delete(name)
        bots.delete(name)
        await letGo(name)
        try { await made.off() } catch { /* unloading */ }
      }
      for (const bot of wanted.values()) {
        bots.set(bot.name, bot)
        const key = JSON.stringify([persona(bot, options.title), bot.display, bot.model ?? null, bot.computers !== false])
        const made = presets.get(bot.name)
        if (made?.key === key) continue
        if (made) {
          await letGo(bot.name)
          try { await made.off() } catch { /* unloading */ }
        }
        presets.set(bot.name, { key, off: await register(bot) })
      }
    }).catch(error => log('bots_sync_failed', { error: String(error?.stack || error) }))
    return syncing
  }

  return {
    starters: STARTERS,
    attach (theHub) { hub = theHub },
    sync,
    bots: () => [...bots.values()].map(({ name, display, description }) => ({ name, display, description })),

    /** The models DSH offers (every provider's catalog), for a bot to think with. */
    async models () {
      const llm = ctx.llm
      if (!llm?.listProviders) return []
      const found = []
      for (const provider of llm.listProviders()) {
        try {
          for (const model of await llm.listModels(provider.id)) {
            found.push({ provider: provider.id, providerName: provider.name, model: model.id, name: model.name || model.id })
          }
        } catch (error) { log('models_failed', { provider: provider.id, error: String(error?.message || error) }) }
      }
      return found
    },

    async reply ({ chat, bot: name, message, context, others = [], tools, sink, signal, user, save }) {
      await syncing
      const bot = bots.get(name)
      if (!bot) throw new Error('that bot is no longer on the hub')
      const known = chat.state.sessions?.[bot.name]
      const { agent, sessionId } = await runner.agentFor({
        sessionId: known, prefix: 'hub', presetId: PRESET + bot.name,
        toolDefinitions: bot.computers === false ? [] : options.toolDefinitions, model: bot.model,
        cwd: workspace, permission: options.permission, title: `${chat.title} · ${bot.display}`,
      })
      if (!sessions.has(bot.name)) sessions.set(bot.name, new Set())
      sessions.get(bot.name).add(sessionId)
      if (sessionId !== known) {
        chat.state = { ...chat.state, sessions: { ...(chat.state.sessions || {}), [bot.name]: sessionId } }
        save(chat.state)
      }
      const text = messageText({ message, context, others, solo: !others.length })
      const reply = await runner.turn({
        agent, text, sink, signal, tools: bot.computers === false ? [] : tools, busy: `${bot.display} is still busy with the last message.`,
        source: user.role === 'owner' ? { kind: 'user' } : { kind: 'dsh-hub', chat: chat.id, sender: message.sender },
        approve: ({ tool, summary, detail, signal: asked }) => hub
          ? hub.ask({ chat, user, bot: bot.display, signal: asked, title: `May ${bot.display} use ${tool}?`, summary, detail })
          : 'denied',
      })
      // the model it answered with: as the agent says, else the bot's own, else DSH's default (what it was given)
      let selection = agent.model?.current?.() ?? (bot.model?.provider ? bot.model : null)
      if (!selection) { try { selection = ctx.agentDefaultModel?.currentSelection?.() } catch { /* none */ } }
      return { text: reply, data: selection?.model ? { provider: selection.provider, model: selection.model } : {} }
    },

    async forget (chat) {
      for (const sessionId of Object.values(chat.state.sessions || {})) await runner.forget(sessionId)
    },

    async close () {
      await syncing
      runner.close()
      for (const made of presets.values()) { try { await made.off() } catch { /* unloading */ } }
    },
  }
}
