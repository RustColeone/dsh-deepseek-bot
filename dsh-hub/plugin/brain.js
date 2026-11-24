// The hub's brain inside DeepSeek Harness: each bot of each chat is a DSH agent with a session of its own, kept across
// restarts (the chat remembers its session ids). A bot is chatty, not a coding agent: its agent preset is the bot's
// persona as the whole system prompt, the time, compaction, and the hub's computer tools, with no workspace tools.
// Running the agents is runner.js's; a DSH approval for one of these agents becomes an approval card in the chat.
import fs from 'node:fs'
import { messageText } from '../lib/text.js'
import { agentRunner } from './runner.js'

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
    'system, GPUs, tools, and whether they can take on a task); computer_run runs a command on one (PowerShell on ' +
    'Windows, bash elsewhere), and the owner may be asked to approve it first; computer_job follows a long job and ' +
    'computer_job_cancel stops it. Pick the computer by what the task needs (a GPU for video work, say). For long ' +
    'work, start it with a short wait, tell the owner it is running and where, and check on it when asked. Files ' +
    'people attach are kept on the hub, each with a file id: computer_send_file copies one to a computer (and says ' +
    'its path there), and computer_get_file brings a file from a computer back into this chat, where the owner can ' +
    'open it. So for "upscale this video on my PC": send it, run the tool on it there, then get the result back. For ' +
    'a task of many steps on one computer, computer_delegate hands it to an agent working on that computer itself, ' +
    'which reports back. Never say you ran or saw something you did not.',
    ...(others.length ? ['', `Also in this chat: ${others.join(', ')}. When a message is for one of them, or a part of ` +
      'the work suits them better, say so and @mention them: they answer next. Messages from others appear as ' +
      '"Name: text".'] : []),
  ].join('\n')
}

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
  const workspace = options.workspace
  fs.mkdirSync(workspace, { recursive: true })
  const runner = await agentRunner(ctx, { createUserMessage: options.createUserMessage, model: options.model, log })
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

  return {
    attach (theHub) { hub = theHub },
    bots: () => bots.map(({ name, display, description }) => ({ name, display, description })),

    async reply ({ chat, bot: name, message, context, tools, sink, signal, user, save }) {
      const bot = bots.find(item => item.name === name)
      const known = chat.state.sessions?.[bot.name]
      const { agent, sessionId } = await runner.agentFor({
        sessionId: known, prefix: 'hub', presetId: PRESET + bot.name, toolDefinitions: options.toolDefinitions,
        cwd: workspace, permission: options.permission, title: `${chat.title} · ${bot.display}`,
      })
      if (sessionId !== known) {
        chat.state = { ...chat.state, sessions: { ...(chat.state.sessions || {}), [bot.name]: sessionId } }
        save(chat.state)
      }
      const text = messageText({ message, context, solo: !(bots.length > 1 && chat.bots?.length !== 1) })
      const reply = await runner.turn({
        agent, text, sink, signal, tools, busy: `${bot.display} is still busy with the last message.`,
        source: user.role === 'owner' ? { kind: 'user' } : { kind: 'dsh-hub', chat: chat.id, sender: message.sender },
        approve: ({ tool, summary, detail, signal: asked }) => hub
          ? hub.ask({ chat, user, bot: bot.display, signal: asked, title: `May ${bot.display} use ${tool}?`, summary, detail })
          : 'denied',
      })
      const selection = agent.model?.current?.()
      return { text: reply, data: selection ? { provider: selection.provider, model: selection.model } : {} }
    },

    async forget (chat) {
      for (const sessionId of Object.values(chat.state.sessions || {})) await runner.forget(sessionId)
    },

    async close () {
      runner.close()
      for (const off of offs) { try { await off() } catch { /* unloading */ } }
    },
  }
}
