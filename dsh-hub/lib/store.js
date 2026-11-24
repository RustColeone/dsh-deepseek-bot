// The hub's one SQLite file (hub.db in its data folder): accounts and their sign-ins, chats and their messages, files,
// the computers joined as nodes, and their pairing codes. Secrets are never kept as they are: passwords as scrypt
// hashes (auth.js), sign-in tokens, node secrets and pairing codes as SHA-256 hashes, so a copy of this file signs
// nobody in.
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SCHEMA = 1

const TABLES = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created REAL NOT NULL,
  changed REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS logins (
  token TEXT PRIMARY KEY,            -- SHA-256 of the cookie's token
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created REAL NOT NULL,
  seen REAL NOT NULL,
  expires REAL NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  agent TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bots TEXT,                         -- JSON list of bot names, NULL for every bot
  pinned INTEGER NOT NULL DEFAULT 0,
  position REAL NOT NULL,
  created REAL NOT NULL,
  updated REAL NOT NULL,
  state TEXT NOT NULL DEFAULT '{}'   -- the brain's own record of the chat (its sessions)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                -- user, text, notice, approval
  speaker TEXT NOT NULL DEFAULT '',  -- the bot that said it
  sender TEXT NOT NULL DEFAULT '',   -- the account that said it
  text TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL DEFAULT '{}',
  files TEXT NOT NULL DEFAULT '[]',
  decided TEXT,
  at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_chat ON messages (chat_id, id);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  origin TEXT NOT NULL DEFAULT 'upload',
  created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  secret TEXT NOT NULL,              -- SHA-256 of the node's secret
  policy TEXT NOT NULL DEFAULT 'ask' CHECK (policy IN ('ask', 'always', 'never')),
  info TEXT NOT NULL DEFAULT '{}',
  created REAL NOT NULL,
  seen REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pairings (
  code TEXT PRIMARY KEY,             -- SHA-256 of the code
  name TEXT NOT NULL,
  created REAL NOT NULL,
  expires REAL NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE CASCADE
);
`

export const now = () => Date.now() / 1000
const json = (text, fallback) => { try { return JSON.parse(text) } catch { return fallback } }

export class Store {
  constructor (folder) {
    fs.mkdirSync(folder, { recursive: true })
    this.folder = folder
    this.filesFolder = path.join(folder, 'files')
    fs.mkdirSync(this.filesFolder, { recursive: true })
    this.db = new DatabaseSync(path.join(folder, 'hub.db'))
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    this.db.exec(TABLES)
    const found = this.get('meta.schema')
    if (found == null) this.set('meta.schema', String(SCHEMA))
    else if (Number(found) > SCHEMA) throw new Error(`hub.db is from a newer dsh-hub (schema ${found})`)
  }

  close () { this.db.close() }
  run (sql, ...args) { return this.db.prepare(sql).run(...args) }
  one (sql, ...args) { return this.db.prepare(sql).get(...args) }
  all (sql, ...args) { return this.db.prepare(sql).all(...args) }

  get (key) { return this.one('SELECT value FROM meta WHERE key = ?', key)?.value ?? null }
  set (key, value) {
    if (value == null) this.run('DELETE FROM meta WHERE key = ?', key)
    else this.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value)
  }

  // ---- accounts -------------------------------------------------------------------------------------
  userCount () { return this.one('SELECT COUNT(*) AS n FROM users').n }
  userByName (name) { return this.one('SELECT * FROM users WHERE name = ?', name) ?? null }
  userById (id) { return this.one('SELECT * FROM users WHERE id = ?', id) ?? null }
  users () { return this.all('SELECT id, name, role, created FROM users ORDER BY id') }
  addUser (name, password, role) {
    const at = now()
    const { lastInsertRowid } = this.run('INSERT INTO users (name, password, role, created, changed) VALUES (?, ?, ?, ?, ?)',
      name, password, role, at, at)
    return this.userById(Number(lastInsertRowid))
  }
  setPassword (id, password) {
    this.run('UPDATE users SET password = ?, changed = ? WHERE id = ?', password, now(), id)
  }
  removeUser (id) { this.run('DELETE FROM users WHERE id = ?', id) }

  addLogin (token, userId, expires, address, agent) {
    const at = now()
    this.run('INSERT INTO logins (token, user_id, created, seen, expires, address, agent) VALUES (?, ?, ?, ?, ?, ?, ?)',
      token, userId, at, at, expires, String(address).slice(0, 64), String(agent).slice(0, 200))
  }
  login (token) { return this.one('SELECT * FROM logins WHERE token = ?', token) ?? null }
  touchLogin (token, expires) { this.run('UPDATE logins SET seen = ?, expires = ? WHERE token = ?', now(), expires, token) }
  dropLogin (token) { this.run('DELETE FROM logins WHERE token = ?', token) }
  dropLogins (userId) { this.run('DELETE FROM logins WHERE user_id = ?', userId) }
  dropExpiredLogins () { this.run('DELETE FROM logins WHERE expires < ?', now()) }
  logins (userId) {
    return this.all('SELECT token, created, seen, expires, address, agent FROM logins WHERE user_id = ? ORDER BY seen DESC', userId)
  }

  // ---- chats ----------------------------------------------------------------------------------------
  chat (id) {
    const row = this.one('SELECT * FROM chats WHERE id = ?', id)
    return row ? this.#chat(row) : null
  }
  #chat (row) {
    return { id: row.id, title: row.title, owner: row.owner_id, bots: row.bots == null ? null : json(row.bots, null),
      pinned: Boolean(row.pinned), position: row.position, created: row.created, updated: row.updated,
      state: json(row.state, {}) }
  }
  chats (ownerId) {
    return this.all('SELECT * FROM chats WHERE owner_id = ? ORDER BY pinned DESC, position ASC', ownerId).map(row => this.#chat(row))
  }
  addChat ({ id, title, owner, bots }) {
    const at = now()
    const first = this.one('SELECT MIN(position) AS p FROM chats WHERE owner_id = ?', owner)?.p
    this.run('INSERT INTO chats (id, title, owner_id, bots, position, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, title, owner, bots == null ? null : JSON.stringify(bots), (first ?? 1) - 1, at, at)
    return this.chat(id)
  }
  renameChat (id, title) { this.run('UPDATE chats SET title = ? WHERE id = ?', title, id) }
  pinChat (id, pinned) { this.run('UPDATE chats SET pinned = ? WHERE id = ?', pinned ? 1 : 0, id) }
  orderChats (ownerId, ids) {
    const update = this.db.prepare('UPDATE chats SET position = ? WHERE id = ? AND owner_id = ?')
    ids.forEach((id, index) => update.run(index, id, ownerId))
  }
  touchChat (id) { this.run('UPDATE chats SET updated = ? WHERE id = ?', now(), id) }
  setChatState (id, state) { this.run('UPDATE chats SET state = ? WHERE id = ?', JSON.stringify(state), id) }
  removeChat (id) {
    const files = this.all("SELECT DISTINCT json_extract(value, '$.id') AS id FROM messages, json_each(messages.files) " +
      'WHERE chat_id = ?', id)
    this.run('DELETE FROM chats WHERE id = ?', id)
    return files.map(row => row.id).filter(Boolean)
  }

  // ---- messages -------------------------------------------------------------------------------------
  #message (row) {
    return { id: row.id, conversation: row.chat_id, kind: row.kind, speaker: row.speaker || undefined,
      sender: row.sender || undefined, text: row.text, data: json(row.data, {}), files: json(row.files, []),
      decided: row.decided ?? undefined, at: row.at }
  }
  addMessage ({ conversation, kind, speaker = '', sender = '', text = '', data = {}, files = [] }) {
    const { lastInsertRowid } = this.run(
      'INSERT INTO messages (chat_id, kind, speaker, sender, text, data, files, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      conversation, kind, speaker, sender, text, JSON.stringify(data), JSON.stringify(files), now())
    this.touchChat(conversation)
    return this.message(Number(lastInsertRowid))
  }
  message (id) {
    const row = this.one('SELECT * FROM messages WHERE id = ?', id)
    return row ? this.#message(row) : null
  }
  decide (id, decided) {
    this.run('UPDATE messages SET decided = ? WHERE id = ? AND decided IS NULL', decided, id)
    return this.message(id)
  }
  history (conversation, after = 0, limit = 300) {
    const rows = this.all('SELECT * FROM (SELECT * FROM messages WHERE chat_id = ? AND id > ? ORDER BY id DESC LIMIT ?) ORDER BY id',
      conversation, after, limit)
    return rows.map(row => this.#message(row))
  }
  last (conversation) {
    const row = this.one("SELECT * FROM messages WHERE chat_id = ? AND kind IN ('user', 'text') ORDER BY id DESC LIMIT 1", conversation)
    return row ? this.#message(row) : null
  }
  /** Approval cards still undecided: after a restart nobody waits for them any more. */
  expireApprovals () {
    const rows = this.all("SELECT id FROM messages WHERE kind = 'approval' AND decided IS NULL")
    this.run("UPDATE messages SET decided = 'expired' WHERE kind = 'approval' AND decided IS NULL")
    return rows.map(row => row.id)
  }

  // ---- files ----------------------------------------------------------------------------------------
  addFile ({ id, name, mime, size, owner = null, origin = 'upload' }) {
    this.run('INSERT INTO files (id, name, mime, size, owner_id, origin, created) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, name, mime, size, owner, origin, now())
    return this.file(id)
  }
  file (id) { return this.one('SELECT id, name, mime, size, owner_id AS owner, origin, created FROM files WHERE id = ?', id) ?? null }
  filePath (id) { return path.join(this.filesFolder, id) }
  removeFile (id) {
    this.run('DELETE FROM files WHERE id = ?', id)
    fs.rmSync(this.filePath(id), { force: true })
  }

  // ---- nodes ----------------------------------------------------------------------------------------
  #node (row) {
    return { id: row.id, name: row.name, policy: row.policy, info: json(row.info, {}), created: row.created, seen: row.seen }
  }
  nodes () { return this.all('SELECT * FROM nodes ORDER BY name').map(row => this.#node(row)) }
  node (id) {
    const row = this.one('SELECT * FROM nodes WHERE id = ?', id)
    return row ? this.#node(row) : null
  }
  nodeSecret (id) { return this.one('SELECT secret FROM nodes WHERE id = ?', id)?.secret ?? null }
  nodeByName (name) {
    const row = this.one('SELECT * FROM nodes WHERE name = ?', name)
    return row ? this.#node(row) : null
  }
  addNode ({ id, name, secret, info }) {
    this.run('INSERT INTO nodes (id, name, secret, info, created) VALUES (?, ?, ?, ?, ?)', id, name, secret,
      JSON.stringify(info ?? {}), now())
    return this.node(id)
  }
  updateNode (id, { name, policy, info, seen }) {
    if (name != null) this.run('UPDATE nodes SET name = ? WHERE id = ?', name, id)
    if (policy != null) this.run('UPDATE nodes SET policy = ? WHERE id = ?', policy, id)
    if (info != null) this.run('UPDATE nodes SET info = ? WHERE id = ?', JSON.stringify(info), id)
    if (seen != null) this.run('UPDATE nodes SET seen = ? WHERE id = ?', seen, id)
    return this.node(id)
  }
  removeNode (id) { this.run('DELETE FROM nodes WHERE id = ?', id) }

  addPairing (code, name, expires, by) {
    this.run('DELETE FROM pairings WHERE expires < ?', now())
    this.run('INSERT INTO pairings (code, name, created, expires, created_by) VALUES (?, ?, ?, ?, ?)', code, name, now(), expires, by)
  }
  /** Use a pairing code up: it answers once, and only before it expires. */
  takePairing (code) {
    const row = this.one('SELECT * FROM pairings WHERE code = ?', code)
    if (!row) return null
    this.run('DELETE FROM pairings WHERE code = ?', code)
    return row.expires >= now() ? row : null
  }
}
