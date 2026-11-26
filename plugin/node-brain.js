// A node's own agents, inside the DSH that runs this computer: the bots that live here, and the agent that does tasks
// hub bots hand over (computer_delegate). Each is a DSH agent on this computer, with this computer's own model account,
// its shell, files and web, and DSH's own approvals, which the hub shows as cards in the chat (node-agent.js asks).
//
// Bots are kept in <folder>/bots.json (those the owner adds from the hub's page) next to the ones in this profile's
// config; a bot's sessions are kept by this computer's DSH, and the hub remembers which session a chat goes with.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { agentRunner } from './runner.js'

const PRESET = 'dsh-hub-node-'
const WORKER = 'dsh-hub-task'
const NAME = /^[a-z][a-z0-9-]{0,31}$/

const slug = text => String(text).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'bot'

/** This computer's tools, as DSH's standard preset has them (and with its settings, which some of them require). */
function localTools () {
  return [
    { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
    process.platform === 'win32'
      ? { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh' }
      : { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' },
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
    { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
    { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60000 } },
    { id: 'compaction', name: 'cordis:group', group: true, isolate: { compaction: true, toolResultPruner: true }, config: [
      { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
      { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
      { id: 'tool-result-pruner', name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
        config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 } },
    ] },
  ]
}

const here = () => `${os.hostname()} (${process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux'}, ` +
  `${process.platform === 'win32' ? 'PowerShell' : 'bash'})`

function botPersona (bot, { inbox }) {
  return [
    bot.prompt || `You are ${bot.display}, an assistant people chat with from their hub's chat page.`,
    '',
    `You live on ${here()}, one of the owner's computers, and you work on it directly: its shell, its files and the ` +
    'web. This is a chat, not a coding session: answer like a person in a messaging app, naturally and briefly, in the ' +
    'language you are written to, and do the work when asked rather than describing it.',
    '',
    `Files the owner attaches are copied to this computer first (into ${inbox}); the message says where. To show a ` +
    'file in the chat (a result, a picture, a video), use chat_send_file with its path. The owner may be asked to ' +
    'approve some of what you do. Never say you ran or saw something you did not.',
  ].join('\n')
}

function taskPersona ({ inbox }) {
  return [
    `You are an agent working on ${here()}, one of the owner's computers, for a bot on their hub, which hands you a ` +
    'task. Do it here with your tools, step by step, without asking questions unless you can\'t go on. Then answer ' +
    'with a short report for that bot: what you did, what came out, and the full paths of any files you made.',
    '',
    `Files sent from the hub are in ${inbox}. If the owner should see a file in the chat, use chat_send_file with its ` +
    'path. The owner may be asked to approve some of what you do. Never report doing something you did not.',
  ].join('\n')
}

const SEND_FILE = {
  name: 'chat_send_file',
  description: 'Post a file from this computer in the chat this conversation comes from, where the owner can open ' +
    'it (pictures and videos show there). Give its full path. A folder has to be zipped first.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'The file\'s full path on this computer.' } },
    required: ['path'],
    additionalProperties: false,
  },
}

/**
 * @param ctx the plugin's context, with agents, agentPresets, approval, sessionQuery, agentDefaultModel
 * @param options { folder, inbox, bots (from the profile's config), workspace, permission, model, createUserMessage, log }
 */
export async function nodeBrain (ctx, options) {
  const log = options.log ?? (() => {})
  const file = path.join(options.folder, 'bots.json')
  const workspace = options.workspace || options.inbox
  fs.mkdirSync(workspace, { recursive: true })
  const runner = await agentRunner(ctx, { createUserMessage: options.createUserMessage, model: options.model, log })
  const presets = new Map() // preset id -> off()

  const fromConfig = (options.bots || []).map(bot => ({ ...bot, name: bot.name || slug(bot.display), own: true }))
  let added = []
  try { added = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* none yet */ }
  const all = () => [...fromConfig, ...added]

  async function register (id, name, prompt) {
    await presets.get(id)?.()
    presets.set(id, await ctx.agentPresets.register({
      id, name, description: 'A dsh-hub agent on this computer', order: 91,
      plugins: [{ id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: prompt, complete: true, includeRuntimeContext: false } },
        ...localTools()],
    }))
  }
  await register(WORKER, 'Hub task agent', taskPersona(options))
  for (const bot of all()) await register(PRESET + bot.name, `${bot.display} (lives here)`, botPersona(bot, options))

  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(added, null, 2) + '\n')
  }

  return {
    bots: () => all().map(({ name, display, description }) => ({ name, display, description: description || '' })),

    async create ({ display, description = '', prompt = '' }) {
      display = String(display || '').trim()
      if (!display) throw new Error('a bot needs a name')
      let name = slug(display)
      for (let count = 2; all().some(bot => bot.name === name); count++) name = `${slug(display).slice(0, 28)}-${count}`
      if (!NAME.test(name)) name = `bot-${Date.now().toString(36)}`
      const bot = { name, display, description: String(description), prompt: String(prompt) }
      await register(PRESET + name, `${display} (lives here)`, botPersona(bot, options))
      added.push(bot)
      save()
      log('bot_added', { name, display })
      return { name, display, description: bot.description }
    },

    async remove (name) {
      const index = added.findIndex(bot => bot.name === name)
      if (index < 0) throw new Error(fromConfig.some(bot => bot.name === name) ? 'that bot is in this computer\'s own config' : `no bot ${name} lives here`)
      added.splice(index, 1)
      save()
      await presets.get(PRESET + name)?.()
      presets.delete(PRESET + name)
      log('bot_removed', { name })
    },

    /** A bot's reply (mode 'reply') or a task (mode 'task'). Resolves { text, session }. */
    async run ({ mode, bot: name, session, text, sink, signal, approve, postFile }) {
      const bot = mode === 'reply' ? all().find(item => item.name === name) : null
      if (mode === 'reply' && !bot) throw new Error(`no bot ${name} lives here`)
      const { agent, sessionId } = await runner.agentFor({
        sessionId: session, prefix: mode === 'reply' ? 'hub-bot' : 'hub-task', presetId: bot ? PRESET + bot.name : WORKER,
        toolDefinitions: [SEND_FILE], cwd: workspace, permission: options.permission,
        title: bot ? `${bot.display} · chat from the hub` : `Task from the hub: ${text.split('\n')[0].slice(0, 60)}`,
      })
      const tools = [{ ...SEND_FILE, run: async ({ path: where }) => {
        const sent = await postFile(where)
        return { posted: true, name: sent.file?.name, size: sent.size }
      } }]
      const reply = await runner.turn({ agent, text, sink, signal, tools, approve,
        busy: bot ? `${bot.display} is still busy with the last message.` : 'that task is still running' })
      return { text: reply, session: sessionId }
    },

    async close () {
      runner.close()
      for (const off of presets.values()) { try { await off() } catch { /* unloading */ } }
    },
  }
}
