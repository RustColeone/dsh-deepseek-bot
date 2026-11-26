// Accounts and signing in. Every hub has accounts, on the home network too: whoever opens the page can run commands on
// your computers, and a hub may end up on the internet whatever the README says. So:
//
// - The first account (the owner) can only be made with the setup code the hub prints in its own console, so nobody
//   else on the network can claim an empty hub first.
// - Passwords are kept as scrypt hashes (N 2^15, r 8, p 1, a 16-byte salt), compared in constant time; a name that
//   doesn't exist costs the same work as a wrong password, so timing doesn't say which names exist.
// - A sign-in is a random 32-byte token in an HttpOnly, SameSite=Strict cookie (Secure over https). The hub keeps only
//   its SHA-256, so a copy of hub.db signs nobody in. It lasts 30 days from its last use; changing a password signs
//   that account out everywhere.
// - Wrong passwords are slowed (a second each) and locked out: 5 wrong in 15 minutes for one name or one address locks
//   that name or address for 15 minutes; 50 wrong from everywhere together in 15 minutes locks out every address
//   outside the home network (never the home network itself, so the owner can always get in at home).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { now } from './store.js'

const scrypt = promisify(crypto.scrypt)
const N = 2 ** 15, R = 8, P = 1, KEY = 32
const MAXMEM = 128 * N * R * 2

export const SESSION_COOKIE = 'hub_session'
export const SESSION_DAYS = 30
export const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,31}$/
export const MIN_PASSWORD = 10
export const MAX_PASSWORD = 256

export const sha256 = text => crypto.createHash('sha256').update(text).digest('hex')
export const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url')

/** The hash kept for a password: `scrypt$N$r$p$salt$hash`, salt and hash in base64. */
export async function hashPassword (password) {
  const salt = crypto.randomBytes(16)
  const hash = await scrypt(String(password).normalize('NFKC'), salt, KEY, { N, r: R, p: P, maxmem: MAXMEM })
  return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join('$')
}

const DUMMY = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

/** Whether the password matches the kept hash. With no hash (no such account) it does the same work and says no. */
export async function verifyPassword (password, stored) {
  const parts = String(stored || DUMMY).split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, n, r, p, salt, hash] = parts
  const expected = Buffer.from(hash, 'base64')
  const found = await scrypt(String(password).normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length,
    { N: Number(n), r: Number(r), p: Number(p), maxmem: 128 * Number(n) * Number(r) * 2 })
  return Boolean(stored) && crypto.timingSafeEqual(found, expected)
}

/** Why a new name or password won't do, or '' when it will. */
export function checkName (name) {
  return NAME.test(String(name || '')) ? '' : 'A name is 2 to 32 letters, digits, dots, dashes or underscores, starting with a letter or digit.'
}
export function checkPassword (password, name = '') {
  const text = String(password || '')
  if (text.length < MIN_PASSWORD) return `A password needs at least ${MIN_PASSWORD} characters.`
  if (text.length > MAX_PASSWORD) return `A password has at most ${MAX_PASSWORD} characters.`
  if (name && text.toLowerCase().includes(String(name).toLowerCase())) return "A password can't contain the account's name."
  if (new Set(text).size < 4) return 'That password is too easy to guess.'
  return ''
}

/** Counts wrong tries per key within a window, and says when a key is locked. */
export class Throttle {
  constructor ({ limit, window, lock }) {
    this.limit = limit
    this.window = window
    this.lock = lock
    this.tries = new Map() // key -> { times: [seconds], until }
  }
  locked (key) {
    const entry = this.tries.get(key)
    return Boolean(entry && entry.until > now())
  }
  fail (key) {
    const at = now()
    const entry = this.tries.get(key) ?? { times: [], until: 0 }
    entry.times = entry.times.filter(time => time > at - this.window)
    entry.times.push(at)
    if (entry.times.length >= this.limit) { entry.until = at + this.lock; entry.times = [] }
    this.tries.set(key, entry)
    if (this.tries.size > 10000) this.#prune(at)
  }
  clear (key) { this.tries.delete(key) }
  #prune (at) {
    for (const [key, entry] of this.tries) {
      if (entry.until < at && !entry.times.some(time => time > at - this.window)) this.tries.delete(key)
    }
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export class Accounts {
  constructor (store, { log = () => {} } = {}) {
    this.store = store
    this.log = log
    this.byName = new Throttle({ limit: 5, window: 900, lock: 900 })
    this.byAddress = new Throttle({ limit: 5, window: 900, lock: 900 })
    this.outside = new Throttle({ limit: 50, window: 900, lock: 900 })
    this.setupCode = null
  }

  get empty () { return this.store.userCount() === 0 }

  /**
   * A fresh setup code for making the first account, shown only on the hub's computer: in its console and, when `file`
   * is given, in that file (the DSH desktop app has no console). The file goes once the owner's account is made.
   */
  newSetupCode (file = null) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    const pick = () => Array.from(crypto.randomBytes(4), byte => alphabet[byte % alphabet.length]).join('')
    this.setupCode = `${pick()}-${pick()}-${pick()}`
    this.codeFile = file
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, `${this.setupCode}\n\nThe setup code for this hub's first account (the owner's): open the hub's ` +
        'page, /setup, and enter it there. It works once, until the hub restarts, and this file is deleted once the ' +
        'account is made.\n', { mode: 0o600 })
    }
    return this.setupCode
  }

  /** A setup code file left from before the owner's account was made. */
  static dropCodeFile (file) {
    try { fs.unlinkSync(file) } catch { /* none */ }
  }

  /** Make the owner account with the console's setup code. Returns { user } or { error }. */
  async setup ({ code, name, password }, address) {
    if (!this.empty) return { error: 'This hub already has its owner. Sign in instead.' }
    if (this.byAddress.locked(address)) return { error: 'Too many wrong tries. Wait a while.' }
    const given = String(code || '').trim().toUpperCase()
    if (!this.setupCode || given.length !== this.setupCode.length ||
        !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(this.setupCode))) {
      this.byAddress.fail(address)
      await sleep(1000)
      return { error: "That isn't the setup code the hub printed." }
    }
    const problem = checkName(name) || checkPassword(password, name)
    if (problem) return { error: problem }
    if (!this.empty) return { error: 'This hub already has its owner. Sign in instead.' }
    const user = this.store.addUser(name, await hashPassword(password), 'owner')
    this.setupCode = null
    if (this.codeFile) Accounts.dropCodeFile(this.codeFile)
    this.log('account_created', { name, role: 'owner' })
    return { user }
  }

  /** Check a name and password. Returns { user } or { error }. `local`: the address is on the home network. */
  async signIn ({ name, password }, address, local) {
    const key = String(name || '').toLowerCase()
    if (this.byName.locked(key) || this.byAddress.locked(address) || (!local && this.outside.locked('*'))) {
      await sleep(1000)
      return { error: 'Too many wrong tries. Wait a while and try again.' }
    }
    const user = typeof name === 'string' && name.length <= 64 ? this.store.userByName(name) : null
    const ok = await verifyPassword(String(password ?? '').slice(0, MAX_PASSWORD * 4), user?.password)
    if (!ok || !user) {
      this.byName.fail(key)
      this.byAddress.fail(address)
      if (!local) this.outside.fail('*')
      this.log('sign_in_refused', { name: key.slice(0, 32), address })
      await sleep(1000)
      return { error: 'Wrong name or password.' }
    }
    this.byName.clear(key)
    this.byAddress.clear(address)
    return { user }
  }

  /** Start a sign-in for the user: the cookie's token (kept only as its hash) and when it expires. */
  startSession (user, address, agent) {
    const value = token()
    const expires = now() + SESSION_DAYS * 86400
    this.store.addLogin(sha256(value), user.id, expires, address, agent)
    return { token: value, expires }
  }

  /** The user a cookie's token signs in, or null. Seen again, its 30 days start over (at most once an hour). */
  session (value) {
    if (typeof value !== 'string' || value.length < 20 || value.length > 100) return null
    const hash = sha256(value)
    const login = this.store.login(hash)
    if (!login) return null
    const at = now()
    if (login.expires < at) { this.store.dropLogin(hash); return null }
    const user = this.store.userById(login.user_id)
    if (!user) return null
    if (at - login.seen > 3600) this.store.touchLogin(hash, at + SESSION_DAYS * 86400)
    return { user, hash }
  }

  endSession (value) { if (typeof value === 'string') this.store.dropLogin(sha256(value)) }

  async changePassword (user, current, next) {
    if (!await verifyPassword(String(current ?? ''), this.store.userById(user.id)?.password)) {
      await sleep(1000)
      return { error: 'Your current password is wrong.' }
    }
    const problem = checkPassword(next, user.name)
    if (problem) return { error: problem }
    this.store.setPassword(user.id, await hashPassword(next))
    this.store.dropLogins(user.id)
    this.log('password_changed', { name: user.name })
    return { ok: true }
  }

  /** The owner adds an account for someone else in the household. */
  async addMember (name, password) {
    const problem = checkName(name) || checkPassword(password, name)
    if (problem) return { error: problem }
    if (this.store.userByName(name)) return { error: 'There is an account with that name already.' }
    const user = this.store.addUser(name, await hashPassword(password), 'member')
    this.log('account_created', { name, role: 'member' })
    return { user }
  }

  /** From the hub's own console only (`dsh-hub password <name>`): a new random password for an account. */
  async resetPassword (name) {
    const user = this.store.userByName(name)
    if (!user) return { error: `No account is called ${name}.` }
    const password = token(12)
    this.store.setPassword(user.id, await hashPassword(password))
    this.store.dropLogins(user.id)
    return { user, password }
  }
}
