// The hub's bots: the ones made on its page (kept in hub.db, which the owner edits and removes), and the ones a DSH
// profile's config lists (shown, but changed only there: `locked`). A fresh hub starts with the brain's own starters
// (DeepSeek in DSH; Echo and Parrot without it), unless the config lists bots.
//
// A bot: { name (its id: lowercase, kept for good), display, description, prompt, preset (the one it began from),
//          picture (a file id on the hub), model ({ provider, model }, or null for DSH's default), computers (may use
//          the owner's computers), shared ('everyone' on the hub, or 'owner' only), locked }
// Bots living on a computer are that computer's (nodes.js); here they only keep a picture.
import { PRESETS } from './presets.js'

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/
const DISPLAY = /^[\p{L}\p{N}][\p{L}\p{N} _.'-]{0,31}$/u
const FILE_ID = /^f[0-9a-f]{20}$/
const SHARED = ['everyone', 'owner']

const slug = text => String(text).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
const fail = error => ({ error })

/** A bot as given (from the page, the config or a starter), checked. Returns { bot } or { error }. */
export function checkBot (input, { name } = {}) {
  const display = String(input.display ?? input.name ?? '').trim()
  if (!DISPLAY.test(display)) return fail('A bot\'s name is 1 to 32 letters, digits, spaces, dots or dashes.')
  const description = String(input.description ?? '').trim()
  if (description.length > 200) return fail('The line about it is at most 200 characters.')
  const prompt = String(input.prompt ?? '').trim()
  if (prompt.length > 8000) return fail('The personality is at most 8000 characters.')
  const preset = String(input.preset ?? '')
  if (preset && !PRESETS.some(item => item.id === preset)) return fail('No such preset.')
  let model = null
  if (input.model && (input.model.provider || input.model.model)) {
    const provider = String(input.model.provider ?? '').trim()
    const id = String(input.model.model ?? '').trim()
    if (!provider || !id || provider.length > 100 || id.length > 200) return fail('Pick a model from the list, or DSH\'s default.')
    model = { provider, model: id }
  }
  const picture = input.picture ? String(input.picture) : null
  if (picture && !FILE_ID.test(picture)) return fail('That picture is not a file on this hub.')
  const shared = input.shared === undefined ? 'everyone' : String(input.shared)
  if (!SHARED.includes(shared)) return fail('A bot is for everyone on the hub, or only for the owner.')
  return { bot: {
    name: name ?? (input.name && NAME.test(String(input.name)) ? String(input.name) : slug(display)),
    display, description, prompt, preset, picture, model, computers: input.computers !== false, shared,
  } }
}

export class Bots {
  /**
   * @param options { store, locked (bots from the config: changed only there), starters (a fresh hub's first bots),
   *   others () (the names and displays taken elsewhere: bots living on computers), onChange (list), log }
   */
  constructor ({ store, locked = [], starters = [], others = () => [], onChange = () => {}, log = () => {} }) {
    this.store = store
    this.others = others
    this.onChange = onChange
    this.log = log
    this.locked = []
    for (const given of locked) {
      const checked = checkBot(given)
      if (checked.error) { log('bot_config_refused', { bot: given?.display ?? given?.name, error: checked.error }); continue }
      this.locked.push({ ...checked.bot, locked: true })
    }
    if (!this.store.get('bots.started')) {
      if (!this.locked.length) {
        for (const given of starters) {
          const checked = checkBot(given)
          if (!checked.error) this.#keep(checked.bot)
        }
      }
      this.store.set('bots.started', '1')
    }
  }

  /** Every bot of the hub's own, the config's first. */
  list () {
    const pictures = this.store.botPictures()
    const locked = this.locked.map(bot => ({ ...bot, picture: pictures[bot.name] ?? null }))
    return [...locked, ...this.store.bots().map(bot => ({ ...bot, picture: pictures[bot.name] ?? null, locked: false }))]
  }

  /** A bot into hub.db; its picture is kept apart (every bot has one there, a config's too). */
  #keep ({ picture, ...bot }) {
    this.store.putBot(bot.name, bot)
    this.store.setBotPicture(bot.name, picture ?? null)
  }

  find (name) { return this.list().find(bot => bot.name === name) ?? null }

  /** Who may chat with a bot: everyone, or only the owner. */
  visible (bot, user) { return !user || user.role === 'owner' || bot.shared !== 'owner' }

  #taken (bot, except = null) {
    const all = [...this.list().filter(item => item.name !== except), ...this.others()]
    if (all.some(item => item.name === bot.name)) return true
    return all.some(item => item.display.toLowerCase() === bot.display.toLowerCase())
  }

  create (input) {
    const checked = checkBot(input)
    if (checked.error) return checked
    const bot = checked.bot
    if (!bot.name) bot.name = `bot-${Date.now().toString(36)}`
    if (this.#taken(bot)) return fail(`There is already a bot called ${bot.display}.`)
    this.#keep(bot)
    this.log('bot_created', { bot: bot.name })
    this.onChange(this.list())
    return { bot: this.find(bot.name) }
  }

  update (name, input) {
    const current = this.find(name)
    if (!current) return fail('No such bot.')
    if (current.locked) {
      // a config's bot is the config's; only its picture is the page's
      if (Object.keys(input).some(key => key !== 'picture')) return fail(`${current.display} is set in the hub's config: change it there.`)
      return this.setPicture(name, input.picture ?? null)
    }
    const checked = checkBot({ ...current, ...input }, { name })
    if (checked.error) return checked
    if (this.#taken(checked.bot, name)) return fail(`There is already a bot called ${checked.bot.display}.`)
    this.#keep(checked.bot)
    this.log('bot_changed', { bot: name })
    this.onChange(this.list())
    return { bot: this.find(name) }
  }

  remove (name) {
    const current = this.find(name)
    if (!current) return fail('No such bot.')
    if (current.locked) return fail(`${current.display} is set in the hub's config: remove it there.`)
    this.store.removeBot(name)
    this.store.setBotPicture(name, null)
    this.log('bot_removed', { bot: name })
    this.onChange(this.list())
    return { ok: true }
  }

  /** The picture of any bot (also a config's, or one living on a computer: `@node/name`); null takes it away. */
  setPicture (name, picture) {
    if (picture !== null && !FILE_ID.test(String(picture))) return fail('That picture is not a file on this hub.')
    this.store.setBotPicture(name, picture)
    this.onChange(this.list())
    return { bot: this.find(name) ?? { name, picture } }
  }

  picture (name) {
    return this.find(name)?.picture ?? this.store.botPictures()[name] ?? null
  }
}
