// The hub itself: each account's chats, who answers in them, and what every open page sees. HTTP and websockets are
// server.js's; thinking is the brain's (the DSH plugin's agents, or the echo brain for trying the page out).
//
// A brain is an object with:
//   bots()                    the bots that can talk: [{ name, display, description }]
//   reply({ chat, bot, message, context, tools, sink, signal })
//                             answer one message as one bot. `context`: what others said in the chat since this bot
//                             last spoke (group chats); `tools`: the hub's tools for this chat (tools.js); `sink`:
//                             stream(text so far), activity(line), and the answer is what it resolves to:
//                             { text, data } (or a string)
//   forget(chat)              the chat was deleted
//   close()
//
// Who answers (Chimera's MomoChat, carried over): the bots @mentioned, in that order; everyone for "everyone" / "you
// all" / "@all" / 大家; else the bot that spoke last here (or the chat's first). A bot that @mentions another in its
// answer hands the next turn to it, at most three hand-offs per message. Each chat answers one message at a time.
import crypto from 'node:crypto'
import { computerTools } from './tools.js'

const EVERYONE = /(^|\s)(@all|@everyone|everyone|you all|all of you|y'all|大家|各位)(\s|[,.!?，。！？]|$)/i
const HANDOFFS = 3
const APPROVAL_MINUTES = 30
const CONTEXT_MESSAGES = 30
const CONTEXT_CHARS = 8000
const CHAT_ID = /^[a-z0-9][a-z0-9-]{0,47}$/
const MAX_TEXT = 20000

const newId = prefix => `${prefix}-${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`
const lastLine = message => message ? { kind: message.kind, speaker: message.speaker ?? '',
  text: String(message.text).split(/\s+/).join(' ').slice(0, 120), at: message.at } : null

export class Hub {
  constructor ({ store, nodes, brain, title = 'Hub', maxUploadMB = 2048, log = () => {} }) {
    this.store = store
    this.nodes = nodes
    this.brain = brain
    this.title = title
    this.maxUploadMB = maxUploadMB
    this.log = log
    this.clients = new Set() // { user, send(event) }
    this.queues = new Map() // chat id -> promise chain
    this.runs = new Map() // run id -> { chat, speaker, controller, text, activity, at }
    this.asks = new Map() // approval message id -> { resolve, user }
    this.jobCards = new Map() // job id -> { message id, chat, owner, timer }
    for (const id of store.expireApprovals()) log('approval_expired_on_start', { message: id })
    brain.attach?.(this)
  }

  // ---- pages ----------------------------------------------------------------------------------------
  bots () { return this.brain.bots() }

  conversations (user) {
    return this.store.chats(user.id).map(chat => ({ id: chat.id, title: chat.title, bots: chat.bots, pinned: chat.pinned,
      last: lastLine(this.store.last(chat.id)) }))
  }

  state (user) {
    let conversations = this.conversations(user)
    if (!conversations.length) {
      this.#create(user, { id: newId('chat'), title: 'First chat' })
      conversations = this.conversations(user)
    }
    return {
      title: this.title, user: { name: user.name, role: user.role }, bots: this.bots(), conversations,
      progress: [...this.runs.values()].filter(run => this.#owns(user, run.chat)).map(run => this.#progress(run)),
      nodes: user.role === 'owner' ? this.nodes.list() : [], default: conversations[0]?.id, maxUploadMB: this.maxUploadMB,
    }
  }

  attach (client) {
    this.clients.add(client)
    client.send({ type: 'hello', state: this.state(client.user) })
    return () => this.clients.delete(client)
  }

  #owns (user, chatId) { return this.store.chat(chatId)?.owner === user.id }
  /** Send to every open page of one account. */
  #tell (userId, event) { for (const client of this.clients) if (client.user.id === userId) client.send(event) }
  #tellOwners (event) { for (const client of this.clients) if (client.user.role === 'owner') client.send(event) }
  #chats (user) { this.#tell(user.id, { type: 'conversations', items: this.conversations(user) }) }
  nodesChanged () { this.#tellOwners({ type: 'nodes', nodes: this.nodes.list() }) }

  /** One event from a page. Returns nothing; answers go back as events. */
  async receive (client, event) {
    const user = client.user
    const chatId = typeof event.conversation === 'string' ? event.conversation : ''
    switch (event.type) {
      case 'send': return this.#send(client, event)
      case 'new': {
        if (!CHAT_ID.test(chatId) || this.store.chat(chatId)) return
        const known = new Set(this.bots().map(bot => bot.name))
        const bots = Array.isArray(event.bots) ? event.bots.filter(name => known.has(name)) : null
        this.#create(user, { id: chatId, title: String(event.title || 'New chat').slice(0, 80), bots: bots?.length ? bots : null })
        return this.#chats(user)
      }
      case 'rename':
        if (!this.#owns(user, chatId)) return
        this.store.renameChat(chatId, String(event.title || '').trim().slice(0, 80) || 'Chat')
        return this.#chats(user)
      case 'pin':
        if (!this.#owns(user, chatId)) return
        this.store.pinChat(chatId, Boolean(event.pinned))
        return this.#chats(user)
      case 'order':
        if (!Array.isArray(event.conversations)) return
        this.store.orderChats(user.id, event.conversations.filter(id => typeof id === 'string').slice(0, 1000))
        return this.#chats(user)
      case 'delete': return this.#delete(user, chatId)
      case 'cancel': return this.#cancel(user, chatId, event.run_id)
      case 'decide': return this.#decide(user, event)
      case 'job_cancel': {
        const job = this.nodes.job(String(event.job || ''))
        if (job && user.role === 'owner') await this.nodes.cancel(job.id)
        return
      }
      default:
    }
  }

  #create (user, { id, title, bots = null }) {
    return this.store.addChat({ id, title, owner: user.id, bots })
  }

  async #delete (user, chatId) {
    const chat = this.store.chat(chatId)
    if (!chat || chat.owner !== user.id) return
    for (const [id, run] of this.runs) if (run.chat === chatId) { run.controller.abort(); this.runs.delete(id) }
    for (const id of this.store.removeChat(chatId)) this.store.removeFile(id)
    try { await this.brain.forget?.(chat) } catch (error) { this.log('brain_forget_failed', { error: String(error) }) }
    this.#tell(user.id, { type: 'deleted', conversation: chatId, items: this.conversations(user) })
  }

  #cancel (user, chatId, runId) {
    for (const [id, run] of this.runs) {
      if (run.chat === chatId && (!runId || id === runId) && this.#owns(user, chatId)) run.controller.abort()
    }
  }

  // ---- messages -------------------------------------------------------------------------------------
  async #send (client, event) {
    const user = client.user
    const chatId = String(event.conversation || '')
    const ack = (ok, reason) => client.send({ type: 'ack', id: event.id, ok, reason })
    const chat = this.store.chat(chatId)
    if (!chat || chat.owner !== user.id) return ack(false, 'unknown_chat')
    const text = String(event.text ?? '').slice(0, MAX_TEXT)
    const files = (Array.isArray(event.files) ? event.files : []).slice(0, 10)
      .map(id => this.store.file(String(id))).filter(file => file && file.owner === user.id)
      .map(({ id, name, mime, size }) => ({ id, name, mime, size }))
    if (!text.trim() && !files.length) return ack(false, 'empty')
    const message = this.store.addMessage({ conversation: chatId, kind: 'user', sender: user.name, text, files })
    if (chat.title === 'New chat' || chat.title === 'First chat') {
      const title = text.split('\n')[0].trim().slice(0, 48)
      if (title) this.store.renameChat(chatId, title)
    }
    this.#tell(user.id, { type: 'message', item: message })
    this.#chats(user)
    ack(true, 'accepted')
    this.#queue(chatId, () => this.#answer(user, chatId, message))
  }

  #queue (chatId, work) {
    const before = this.queues.get(chatId) ?? Promise.resolve()
    const next = before.then(work).catch(error => this.log('answer_failed', { chat: chatId, error: String(error?.stack || error) }))
    this.queues.set(chatId, next)
    next.finally(() => { if (this.queues.get(chatId) === next) this.queues.delete(chatId) })
    return next
  }

  /** The bots of a chat, as the brain has them. */
  #members (chat) {
    const all = this.bots()
    return chat.bots ? all.filter(bot => chat.bots.includes(bot.name)) : all
  }

  /** The chat's bots @mentioned in a text, in the order they are mentioned. */
  mentioned (chat, text) {
    const said = String(text).toLowerCase()
    return this.#members(chat)
      .map(bot => ({ bot, at: Math.min(...[bot.display, bot.name].map(name => {
        const found = said.search(new RegExp(`@${escape(name.toLowerCase())}(?![\\p{L}\\p{N}])`, 'u'))
        return found < 0 ? Infinity : found
      })) }))
      .filter(item => item.at !== Infinity).sort((one, other) => one.at - other.at).map(item => item.bot)
  }

  /** Who answers a message: mentioned bots, everyone, or whose turn it is. */
  speakers (chat, text, history = []) {
    const members = this.#members(chat)
    if (members.length <= 1) return members
    if (EVERYONE.test(String(text))) return members
    const mentioned = this.mentioned(chat, text)
    if (mentioned.length) return mentioned
    const last = [...history].reverse().find(item => item.kind === 'text' && members.some(bot => bot.name === item.data?.bot))
    return [members.find(bot => bot.name === last?.data?.bot) ?? members[0]]
  }

  /** What others said since this bot last spoke, for a group chat. */
  #context (chat, bot, history, upTo) {
    if (this.#members(chat).length <= 1) return []
    let start = 0
    for (let index = history.length - 1; index >= 0; index--) {
      if (history[index].kind === 'text' && history[index].data?.bot === bot.name) { start = index + 1; break }
    }
    const lines = history.slice(start).filter(item => item.id !== upTo && ['user', 'text'].includes(item.kind))
      .slice(-CONTEXT_MESSAGES).map(item => ({ who: item.kind === 'user' ? item.sender : item.speaker, text: item.text }))
    let total = 0
    const kept = []
    for (const line of lines.reverse()) {
      total += line.text.length
      if (total > CONTEXT_CHARS) break
      kept.unshift(line)
    }
    return kept
  }

  async #answer (user, chatId, message) {
    let queue = null
    let handoffs = 0
    let said = message.text
    while (true) {
      const chat = this.store.chat(chatId)
      if (!chat) return
      const history = this.store.history(chatId, 0, 200)
      queue ??= this.speakers(chat, said, history)
      const bot = queue.shift()
      if (!bot) return
      const reply = await this.#reply(user, chat, bot, message, history)
      if (!reply) continue
      // A bot that @mentions another hands it the next turn.
      if (handoffs < HANDOFFS && this.#members(chat).length > 1) {
        const next = this.mentioned(chat, reply.text).filter(other => other.name !== bot.name)
        if (next.length && !queue.length) { queue = next.slice(0, 1); handoffs++; said = reply.text; message = reply }
      }
    }
  }

  async #reply (user, chat, bot, message, history) {
    const runId = newId('run')
    const run = { id: runId, chat: chat.id, speaker: bot.display, bot: bot.name, controller: new AbortController(),
      text: '', activity: 'thinking…', at: Date.now() / 1000 }
    this.runs.set(runId, run)
    const progress = () => this.#tell(user.id, { type: 'progress', ...this.#progress(run) })
    progress()
    let streamed = 0
    const sink = {
      stream: text => {
        run.text = String(text)
        const at = Date.now()
        if (at - streamed > 80) { streamed = at; progress() }
      },
      activity: line => { run.activity = String(line); progress() },
    }
    const tools = user.role === 'owner' ? computerTools(this, { chat, user, bot: bot.display }) : []
    try {
      const answer = await this.brain.reply({
        chat, bot: bot.name, message: { text: message.text, sender: message.sender || message.speaker, files: this.#files(message) },
        context: this.#context(chat, bot, history, message.id), tools, sink, signal: run.controller.signal, user,
        save: state => this.store.setChatState(chat.id, state),
      })
      const { text, data } = typeof answer === 'string' ? { text: answer, data: {} } : (answer ?? {})
      if (!text || !String(text).trim()) return null
      const item = this.store.addMessage({ conversation: chat.id, kind: 'text', speaker: bot.display, text: String(text),
        data: { ...(data || {}), bot: bot.name } })
      this.#tell(user.id, { type: 'message', item })
      return item
    } catch (error) {
      if (run.controller.signal.aborted) {
        this.#notice(user, chat.id, `${bot.display} stopped.`)
      } else {
        this.log('reply_failed', { chat: chat.id, bot: bot.name, error: String(error?.stack || error) })
        this.#notice(user, chat.id, `⚠️ ${bot.display} couldn't answer: ${error?.message || error}`)
      }
      return null
    } finally {
      this.runs.delete(runId)
      this.#tell(user.id, { type: 'progress_clear', conversation: chat.id, run_id: runId })
      this.#chats(user)
    }
  }

  #progress (run) {
    return { conversation: run.chat, run_id: run.id, speaker: run.speaker, text: run.text, activity: run.activity, at: run.at }
  }

  #files (message) {
    return (message.files || []).map(file => ({ ...file, path: this.store.filePath(file.id) }))
  }

  #notice (user, chatId, text, data = {}) {
    const item = this.store.addMessage({ conversation: chatId, kind: 'notice', text, data })
    this.#tell(user.id, { type: 'message', item })
    return item
  }

  // ---- approvals ------------------------------------------------------------------------------------
  /**
   * Ask the account in its chat whether something may happen. Resolves 'approved', 'always', 'denied', 'expired' or
   * 'cancelled' (the turn was stopped). Only an owner can approve.
   */
  ask ({ chat, user, bot, title, summary, detail = '', meta = '', always = '', signal }) {
    const item = this.store.addMessage({ conversation: chat.id, kind: 'approval', speaker: bot || '', text: summary,
      data: { title, summary, detail, meta, always } })
    this.#tell(user.id, { type: 'message', item })
    return new Promise(resolve => {
      const settle = decision => {
        if (!this.asks.has(item.id)) return
        this.asks.delete(item.id)
        clearTimeout(timer)
        signal?.removeEventListener('abort', cancelled)
        const decided = this.store.decide(item.id, decision)
        this.#tell(user.id, { type: 'update', item: decided })
        resolve(decision)
      }
      const cancelled = () => settle('cancelled')
      const timer = setTimeout(() => settle('expired'), APPROVAL_MINUTES * 60 * 1000)
      signal?.addEventListener('abort', cancelled, { once: true })
      this.asks.set(item.id, { settle, user: user.id })
    })
  }

  #decide (user, { message, decision }) {
    const ask = this.asks.get(Number(message))
    if (!ask || ask.user !== user.id || user.role !== 'owner') return
    if (!['approved', 'always', 'denied'].includes(decision)) return
    this.log('approval_decided', { message, decision, by: user.name })
    ask.settle(decision)
  }

  // ---- job cards: a command running on a computer, live in the chat ---------------------------------
  jobCard (chat, job, bot) {
    const item = this.store.addMessage({ conversation: chat.id, kind: 'job', speaker: bot || '', text: job.command,
      data: job.view(3000) })
    this.jobCards.set(job.id, { message: item.id, chat: chat.id, owner: chat.owner, timer: null })
    this.#tell(chat.owner, { type: 'message', item })
    if (job.done) this.jobChanged(job)
  }

  /** A job's output or state changed: its card follows, at most once a second while it runs. */
  jobChanged (job) {
    if (job.done && job.kind === 'get' && job.status === 'done' && job.file && !job.posted) this.#posted(job)
    const card = this.jobCards.get(job.id)
    if (!card) return
    const write = () => {
      card.timer = null
      this.store.run('UPDATE messages SET data = ? WHERE id = ?', JSON.stringify(job.view(3000)), card.message)
      this.#tell(card.owner, { type: 'update', item: this.store.message(card.message) })
      if (job.done) this.jobCards.delete(job.id)
    }
    if (job.done) { clearTimeout(card.timer); write() } else if (!card.timer) card.timer = setTimeout(write, 1000)
  }

  /** A file brought from a computer arrives in the chat that asked for it, from the bot that asked. */
  #posted (job) {
    job.posted = true
    const chat = this.store.chat(job.chat)
    if (!chat) return
    const item = this.store.addMessage({ conversation: chat.id, kind: 'file', speaker: job.bot, text: `From ${job.nodeName}: ${job.file.name}`,
      files: [job.file], data: { job: job.id, node: job.nodeName, path: job.result?.path } })
    this.#tell(chat.owner, { type: 'message', item })
  }

  close () {
    for (const run of this.runs.values()) run.controller.abort()
    for (const ask of this.asks.values()) ask.settle('cancelled')
  }
}

function escape (text) { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
