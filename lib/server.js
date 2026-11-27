// The hub's HTTP(S) server: the pages, their API, files, and two websockets: /ws for open pages (an account's
// sign-in cookie), /node for computers (their own secret). Every request passes the guard first (guard.js); every API
// route that changes something takes JSON only, from this page's own origin (the guard), with a SameSite=Strict
// cookie, so another website can't make a signed-in browser do anything here.
//
// Routes (paths are relative, so the hub also works under a reverse proxy's sub-path):
//   GET  /                     the chat page; /login, /setup before that
//   POST /api/setup            { code, name, password }: the owner account, with the console's setup code
//   POST /api/login            { name, password }        POST /api/logout
//   GET  /api/me               the account, and where it is signed in
//   POST /api/password         { current, next }: signs the account out everywhere
//   GET  /api/users            owner: the accounts        POST /api/users { name, password }   POST /api/users/remove { id }
//   GET  /api/history          ?conversation=&after=: a chat's messages (the latest 300, or those after an id)
//   POST /api/upload           ?name=: the file itself as the body (up to maxUploadMB); answers { file }
//   GET  /files/<id>           a file (pictures, audio, video and PDF shown; anything else downloaded); ranges for video
//   GET  /api/nodes            owner: the computers       POST /api/nodes/pair { name }: a pairing code
//   POST /api/nodes/update     owner: { id, name?, policy? }    POST /api/nodes/remove { id }
//   GET  /api/bots             owner: every bot as edited (personality, model, who may use it), the computers bots
//                              may live on, the models, the presets
//   POST /api/bots             owner: a new bot { display, description, prompt, preset, model, computers, shared,
//                              picture, home? (a computer's id: it lives there) }
//   POST /api/bots/update      owner: { name, ...what changes }      POST /api/bots/remove { name }
//   POST /api/bots/picture     owner: an image as the body (up to 5 MB): a bot's picture; answers { file }
//   POST /api/nodes/bots       owner: { node, display, description, prompt }: a bot that lives on that computer
//   POST /api/nodes/bots/remove owner: { node, name }
//   POST /api/nodes/enroll     a computer joins: { code, info } (no account; the pairing code is the proof)
//   GET  /api/nodes/download   ?ticket=: a node fetches the file the hub sent it (its secret and the ticket; ranges)
//   POST /api/nodes/upload     ?ticket=&name=: a node sends the file the hub asked it for (its secret and the ticket)
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { SESSION_COOKIE, SESSION_DAYS } from './auth.js'
import { PRESETS } from './presets.js'
import { securityHeaders } from './guard.js'

const STATIC = fileURLToPath(new URL('../static/', import.meta.url))
const STATIC_NAME = /^[a-z0-9_-]+\.(js|css|woff2|svg|png|txt)$/
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.html': 'text/html; charset=utf-8' }
const INLINE = /^(image\/(png|jpeg|gif|webp|avif)|audio\/[\w.+-]+|video\/[\w.+-]+|application\/pdf)$/
const MIME = /^[a-z]+\/[a-z0-9.+-]{1,80}$/
const JSON_LIMIT = 64 * 1024
const PICTURE = /^image\/(png|jpeg|gif|webp|avif)$/
const PICTURE_LIMIT = 5 * 1024 * 1024
const BOT_FIELDS = ['display', 'description', 'prompt', 'preset', 'model', 'computers', 'shared', 'picture']
/** What a page sent about a bot: only the fields a bot has. */
const botInput = given => Object.fromEntries(BOT_FIELDS.filter(key => given[key] !== undefined).map(key => [key, given[key]]))
const FILE_ID = /^f[0-9a-f]{20}$/
// A node's file is typed by its name here, never by what the node says.
const BY_EXTENSION = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.wav': 'audio/wav', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.pdf': 'application/pdf',
  '.txt': 'text/plain', '.log': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json',
  '.zip': 'application/zip', '.7z': 'application/x-7z-compressed' }

function cookies (request) {
  const found = {}
  for (const part of String(request.headers.cookie || '').split(';')) {
    const at = part.indexOf('=')
    if (at > 0) found[part.slice(0, at).trim()] = decodeURIComponent(part.slice(at + 1).trim())
  }
  return found
}

const escapeHtml = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))

export function safeName (name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/'))
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').replace(/^\.+/, '').trim()
  return (base || 'file').slice(0, 120)
}

export class HttpError extends Error {
  constructor (status, message) { super(message); this.status = status }
}

export function createServer ({ hub, accounts, nodes, guard, tls = null, log = () => {}, title = 'Hub' }) {
  const handler = (request, response) => {
    handle(request, response).catch(error => {
      const status = error instanceof HttpError ? error.status : 500
      if (status === 500) log('request_failed', { path: String(request.url).slice(0, 80), error: String(error?.stack || error) })
      if (!response.headersSent) send(response, status, { error: status === 500 ? 'Something went wrong.' : error.message })
      else response.destroy()
    })
  }
  const server = tls ? https.createServer({ cert: tls.cert, key: tls.key }, handler) : http.createServer(handler)
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
  const nodeSockets = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 })

  function headers (request, extra = {}) {
    return { ...securityHeaders(request.client?.secure), ...extra }
  }
  function send (response, status, body, extra = {}) {
    const text = JSON.stringify(body)
    response.writeHead(status, headers(response.req, { 'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(text), ...extra }))
    response.end(text)
  }
  function redirect (response, where) {
    response.writeHead(303, headers(response.req, { Location: where, 'Cache-Control': 'no-store' }))
    response.end()
  }
  function page (response, name, values = {}) {
    let text = fs.readFileSync(path.join(STATIC, name), 'utf8')
    for (const [key, value] of Object.entries({ title, ...values })) text = text.replaceAll(`{{${key}}}`, escapeHtml(value))
    response.writeHead(200, headers(response.req, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-cache' }))
    response.end(text)
  }
  function sessionCookie (request, value, maxAge) {
    return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}` +
      (request.client.secure ? '; Secure' : '')
  }

  async function body (request) {
    if (!String(request.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'Send JSON.')
    let size = 0
    const parts = []
    for await (const chunk of request) {
      size += chunk.length
      if (size > JSON_LIMIT) throw new HttpError(413, 'Too large.')
      parts.push(chunk)
    }
    try { return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}') } catch { throw new HttpError(400, 'That is not JSON.') }
  }

  function signedIn (request) { return accounts.session(cookies(request)[SESSION_COOKIE]) }
  function need (request, role) {
    const session = signedIn(request)
    if (!session) throw new HttpError(401, 'Sign in first.')
    if (role === 'owner' && session.user.role !== 'owner') throw new HttpError(403, 'Only the owner can do that.')
    return session.user
  }

  async function handle (request, response) {
    const client = request.client = guard.client(request)
    const url = new URL(request.url, 'http://hub')
    const route = url.pathname
    const method = request.method
    const enrolling = route === '/api/nodes/enroll'
    const machine = enrolling || route === '/api/nodes/download' || route === '/api/nodes/upload'
    const why = guard.check(request, client, { browser: !machine })
    if (why) return send(response, 403, { error: `Refused (${why}).` })

    // ---- pages and their files
    if (method === 'GET' && route === '/') {
      if (accounts.empty) return redirect(response, 'setup')
      if (!signedIn(request)) return redirect(response, 'login')
      return page(response, 'index.html')
    }
    if (method === 'GET' && route === '/login') {
      if (accounts.empty) return redirect(response, 'setup')
      return signedIn(request) ? redirect(response, './') : page(response, 'login.html')
    }
    if (method === 'GET' && route === '/setup') return accounts.empty ? page(response, 'setup.html') : redirect(response, 'login')
    if (method === 'GET' && (route === '/favicon.ico' || route === '/favicon.svg')) return file(response, path.join(STATIC, 'favicon.svg'))
    if (method === 'GET' && route.startsWith('/static/')) {
      const name = route.slice('/static/'.length)
      if (!STATIC_NAME.test(name)) throw new HttpError(404, 'No such file.')
      return file(response, path.join(STATIC, name), name.endsWith('.woff2') ? 'public, max-age=604800' : 'no-cache')
    }

    // ---- accounts
    if (method === 'POST' && route === '/api/setup') {
      const given = await body(request)
      const { user, error } = await accounts.setup(given, client.address)
      if (error) return send(response, 400, { error })
      const { token } = accounts.startSession(user, client.address, request.headers['user-agent'] || '')
      return send(response, 200, { ok: true }, { 'Set-Cookie': sessionCookie(request, token, SESSION_DAYS * 86400) })
    }
    if (method === 'POST' && route === '/api/login') {
      const given = await body(request)
      const { user, error } = await accounts.signIn(given, client.address, client.local)
      if (error) return send(response, 401, { error })
      const { token } = accounts.startSession(user, client.address, request.headers['user-agent'] || '')
      log('signed_in', { name: user.name, address: client.address })
      return send(response, 200, { ok: true }, { 'Set-Cookie': sessionCookie(request, token, SESSION_DAYS * 86400) })
    }
    if (method === 'POST' && route === '/api/logout') {
      await body(request)
      accounts.endSession(cookies(request)[SESSION_COOKIE])
      return send(response, 200, { ok: true }, { 'Set-Cookie': sessionCookie(request, '', 0) })
    }
    if (method === 'GET' && route === '/api/me') {
      const session = signedIn(request)
      if (!session) throw new HttpError(401, 'Sign in first.')
      const logins = accounts.store.logins(session.user.id).map(login => ({ created: login.created, seen: login.seen,
        address: login.address, agent: login.agent, current: login.token === session.hash }))
      return send(response, 200, { user: { name: session.user.name, role: session.user.role }, logins,
        secure: client.secure, local: client.local })
    }
    if (method === 'POST' && route === '/api/password') {
      const user = need(request)
      const given = await body(request)
      const answer = await accounts.changePassword(user, given.current, given.next)
      if (answer.error) return send(response, 400, answer)
      return send(response, 200, { ok: true }, { 'Set-Cookie': sessionCookie(request, '', 0) })
    }
    if (method === 'GET' && route === '/api/users') {
      need(request, 'owner')
      return send(response, 200, { users: accounts.store.users() })
    }
    if (method === 'POST' && route === '/api/users') {
      need(request, 'owner')
      const given = await body(request)
      const answer = await accounts.addMember(given.name, given.password)
      return answer.error ? send(response, 400, answer) : send(response, 200, { ok: true })
    }
    if (method === 'POST' && route === '/api/users/remove') {
      const user = need(request, 'owner')
      const given = await body(request)
      if (Number(given.id) === user.id) return send(response, 400, { error: "You can't remove your own account." })
      const other = accounts.store.userById(Number(given.id))
      if (!other) return send(response, 404, { error: 'No such account.' })
      if (other.role === 'owner') return send(response, 400, { error: "An owner's account can't be removed here." })
      accounts.store.removeUser(other.id)
      log('account_removed', { name: other.name, by: user.name })
      return send(response, 200, { ok: true })
    }

    // ---- chats and files
    if (method === 'GET' && route === '/api/history') {
      const user = need(request)
      const conversation = url.searchParams.get('conversation') || ''
      const chat = hub.store.chat(conversation)
      if (!chat || chat.owner !== user.id) return send(response, 404, { error: 'No such chat.' })
      const after = Number(url.searchParams.get('after') || 0)
      if (!Number.isSafeInteger(after) || after < 0) return send(response, 400, { error: 'Bad id.' })
      return send(response, 200, { messages: hub.store.history(conversation, after) })
    }
    if (method === 'POST' && route === '/api/upload') return pageUpload(request, response, url, need(request))
    if (method === 'GET' && route.startsWith('/files/')) {
      const user = need(request)
      const id = route.slice('/files/'.length)
      const found = FILE_ID.test(id) ? hub.store.file(id) : null
      if (!found || (found.owner != null && found.owner !== user.id && user.role !== 'owner')) throw new HttpError(404, 'No such file.')
      return stored(request, response, found)
    }

    // ---- computers
    if (method === 'GET' && route === '/api/nodes') {
      need(request, 'owner')
      return send(response, 200, { nodes: nodes.list(), jobs: nodes.jobList().slice(0, 50).map(job => job.view()) })
    }
    if (method === 'POST' && route === '/api/nodes/pair') {
      const user = need(request, 'owner')
      const given = await body(request)
      const answer = nodes.pair(String(given.name || ''), user)
      return send(response, answer.error ? 400 : 200, answer)
    }
    if (method === 'POST' && route === '/api/nodes/update') {
      need(request, 'owner')
      const given = await body(request)
      if (!nodes.store.node(String(given.id))) return send(response, 404, { error: 'No such computer.' })
      const answer = nodes.update(String(given.id), { name: given.name, policy: given.policy })
      return send(response, answer.error ? 400 : 200, answer)
    }
    if (method === 'POST' && route === '/api/nodes/remove') {
      need(request, 'owner')
      const given = await body(request)
      return nodes.remove(String(given.id)) ? send(response, 200, { ok: true }) : send(response, 404, { error: 'No such computer.' })
    }
    // ---- bots
    if (method === 'GET' && route === '/api/bots') {
      need(request, 'owner')
      return send(response, 200, { ...await hub.botSettings(), presets: PRESETS })
    }
    if (method === 'POST' && route === '/api/bots') {
      need(request, 'owner')
      const given = await body(request)
      const answer = await hub.createBot({ ...botInput(given), ...(given.home ? { home: String(given.home) } : {}) })
      return send(response, answer.error ? 400 : 200, answer)
    }
    if (method === 'POST' && route === '/api/bots/update') {
      need(request, 'owner')
      const given = await body(request)
      const answer = await hub.updateBot(String(given.name || ''), botInput(given))
      return send(response, answer.error ? 400 : 200, answer)
    }
    if (method === 'POST' && route === '/api/bots/remove') {
      need(request, 'owner')
      const given = await body(request)
      const answer = await hub.removeBot(String(given.name || ''))
      return send(response, answer.error ? 400 : 200, answer)
    }
    if (method === 'POST' && route === '/api/bots/picture') {
      need(request, 'owner')
      const type = String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
      if (!PICTURE.test(type)) throw new HttpError(415, "A bot's picture is a PNG, JPEG, GIF, WebP or AVIF image.")
      // a bot's picture is everyone's to see (owner null), as the bot is
      const kept = await upload(request, { name: `bot-picture.${type.split('/')[1]}`, mime: type, owner: null, origin: 'bot-picture', limit: PICTURE_LIMIT })
      return send(response, 200, { file: kept.file })
    }
    if (method === 'POST' && route === '/api/nodes/bots') {
      need(request, 'owner')
      const given = await body(request)
      const answer = await hub.addNodeBot(String(given.node || ''), {
        display: String(given.display || '').trim(), description: String(given.description || '').trim(),
        prompt: String(given.prompt || '').trim(),
      })
      return send(response, answer.error ? 400 : 200, answer)
    }
    if (method === 'POST' && route === '/api/nodes/bots/remove') {
      need(request, 'owner')
      const given = await body(request)
      const answer = await hub.removeNodeBot(String(given.node || ''), String(given.name || ''))
      return send(response, answer.error ? 400 : 200, answer)
    }
    if (method === 'POST' && enrolling) {
      const given = await body(request)
      const answer = nodes.enroll(given, client.address)
      return send(response, answer.status ?? 200, answer)
    }
    if (method === 'GET' && route === '/api/nodes/download') {
      const ticket = nodeTicket(request, url, 'down')
      const found = hub.store.file(ticket.file)
      if (!found) throw new HttpError(404, 'That file is gone from the hub.')
      return stored(request, response, found, { download: true })
    }
    if (method === 'POST' && route === '/api/nodes/upload') {
      const ticket = nodeTicket(request, url, 'up')
      nodes.claim(url.searchParams.get('ticket'))
      const name = safeName(url.searchParams.get('name'))
      const limit = Math.min(ticket.limit || Infinity, hub.maxUploadMB * 1024 * 1024)
      const kept = await upload(request, { name, mime: BY_EXTENSION[path.extname(name).toLowerCase()] || 'application/octet-stream',
        owner: ticket.owner, origin: `node:${node(request).name}`, limit })
      if (ticket.onFile) ticket.onFile(kept.file) // a bot posting a file in its chat
      else ticket.job.file = kept.file
      return send(response, 200, kept)
    }
    throw new HttpError(404, 'Nothing here.')
  }

  const node = request => nodes.authenticate(request.headers.authorization)

  /** The ticket a node shows for a file, which must be its own: its secret and a live ticket for that way. */
  function nodeTicket (request, url, way) {
    const node = nodes.authenticate(request.headers.authorization)
    if (!node) throw new HttpError(401, 'This computer is not joined to the hub.')
    const ticket = nodes.ticket(node, url.searchParams.get('ticket'), way)
    if (!ticket) {
      log('ticket_refused', { node: node.name, way })
      throw new HttpError(403, 'That ticket is wrong, spent or expired.')
    }
    return ticket
  }

  function file (response, where, cache = 'no-cache') {
    let data
    try { data = fs.readFileSync(where) } catch { throw new HttpError(404, 'No such file.') }
    response.writeHead(200, headers(response.req, { 'Content-Type': TYPES[path.extname(where)] || 'application/octet-stream',
      'Cache-Control': cache, 'Content-Length': data.length }))
    response.end(data)
  }

  /** A page's upload: the file itself is the body, typed by its Content-Type. */
  async function pageUpload (request, response, url, user) {
    const type = String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
    const kept = await upload(request, { name: safeName(url.searchParams.get('name')), mime: MIME.test(type) ? type : 'application/octet-stream',
      owner: user.id, origin: 'upload', limit: hub.maxUploadMB * 1024 * 1024 })
    return send(response, 200, { file: kept.file })
  }

  /** Stream a request's body to a new file on the hub's disk, within `limit` bytes. Answers { file, sha256 }. */
  async function upload (request, { name, mime, owner, origin, limit }) {
    const most = `Files are at most ${Math.round(limit / 1024 / 1024)} MB.`
    if (Number(request.headers['content-length'] || 0) > limit) throw new HttpError(413, most)
    const id = `f${crypto.randomBytes(10).toString('hex')}`
    const where = hub.store.filePath(id)
    const hash = crypto.createHash('sha256')
    let size = 0
    const counter = async function * (source) {
      for await (const chunk of source) {
        size += chunk.length
        if (size > limit) throw new HttpError(413, most)
        hash.update(chunk)
        yield chunk
      }
    }
    try {
      await pipeline(request, counter, fs.createWriteStream(where, { flags: 'wx' }))
    } catch (error) {
      fs.rmSync(where, { force: true })
      throw error
    }
    const kept = hub.store.addFile({ id, name, mime, size, owner, origin })
    return { file: { id: kept.id, name: kept.name, mime: kept.mime, size: kept.size }, sha256: hash.digest('hex') }
  }

  function stored (request, response, found, { download = false } = {}) {
    const where = hub.store.filePath(found.id)
    let stat
    try { stat = fs.statSync(where) } catch { throw new HttpError(404, 'That file is gone.') }
    const inline = !download && INLINE.test(found.mime)
    const extra = {
      'Content-Type': inline ? found.mime : 'application/octet-stream',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(found.name)}`,
      'Cache-Control': 'private, max-age=3600', 'Accept-Ranges': 'bytes',
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range || ''))
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : stat.size - Number(range[2])
      let end = range[1] && range[2] ? Number(range[2]) : stat.size - 1
      start = Math.max(0, start)
      end = Math.min(end, stat.size - 1)
      if (start > end) {
        response.writeHead(416, headers(request, { 'Content-Range': `bytes */${stat.size}` }))
        return response.end()
      }
      response.writeHead(206, headers(request, { ...extra, 'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': end - start + 1 }))
      return fs.createReadStream(where, { start, end }).pipe(response)
    }
    response.writeHead(200, headers(request, { ...extra, 'Content-Length': stat.size }))
    fs.createReadStream(where).pipe(response)
  }

  // ---- websockets
  server.on('upgrade', (request, socket, head) => {
    const refuse = (status, text) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      socket.destroy()
    }
    try {
      const client = request.client = guard.client(request)
      const route = new URL(request.url, 'http://hub').pathname
      if (route === '/ws') {
        if (guard.check(request, client)) return refuse(403, 'Forbidden')
        const value = cookies(request)[SESSION_COOKIE]
        const session = accounts.session(value)
        if (!session) return refuse(401, 'Unauthorized')
        sockets.handleUpgrade(request, socket, head, ws => openPage(ws, session, value))
      } else if (route === '/node') {
        if (guard.check(request, client, { browser: false })) return refuse(403, 'Forbidden')
        const node = nodes.authenticate(request.headers.authorization)
        if (!node) {
          log('node_refused', { address: client.address })
          return refuse(401, 'Unauthorized')
        }
        nodeSockets.handleUpgrade(request, socket, head, ws => nodes.attach(node, ws))
      } else {
        refuse(404, 'Not Found')
      }
    } catch (error) {
      log('upgrade_failed', { error: String(error) })
      socket.destroy()
    }
  })

  /** An open page: its events go to the hub; it is closed (4401) as soon as its sign-in ends. */
  function openPage (ws, session, value) {
    const client = { user: session.user, send: event => { if (ws.readyState === 1) ws.send(JSON.stringify(event)) } }
    const detach = hub.attach(client)
    let alive = true
    ws.on('pong', () => { alive = true })
    const check = setInterval(() => {
      if (!accounts.session(value)) { ws.close(4401, 'signed out'); return }
      if (!alive) { ws.terminate(); return }
      alive = false
      ws.ping()
    }, 30000)
    ws.on('message', data => {
      let event
      try { event = JSON.parse(String(data)) } catch { return }
      if (!event || typeof event !== 'object') return
      hub.receive(client, event).catch(error => log('event_failed', { type: String(event.type), error: String(error?.stack || error) }))
    })
    ws.on('close', () => { clearInterval(check); detach() })
  }

  const beat = setInterval(() => nodes.heartbeat(), 30000)
  server.on('close', () => clearInterval(beat))
  /**
   * Stopping: every page and computer is told the hub is going (1001), and a socket that hasn't closed half a second
   * later is cut. server.close() alone would wait for them forever: a phone keeps its page open.
   */
  server.dropSockets = async () => {
    clearInterval(beat)
    const all = [...sockets.clients, ...nodeSockets.clients]
    for (const ws of all) { try { ws.close(1001, 'the hub is stopping') } catch { /* gone */ } }
    if (!all.length) return
    await new Promise(resolve => setTimeout(resolve, 500).unref())
    for (const ws of all) { try { ws.terminate() } catch { /* gone */ } }
  }
  return server
}
