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
//   POST /api/nodes/enroll     a computer joins: { code, info } (no account; the pairing code is the proof)
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { SESSION_COOKIE, SESSION_DAYS } from './auth.js'
import { securityHeaders } from './guard.js'

const STATIC = fileURLToPath(new URL('../static/', import.meta.url))
const STATIC_NAME = /^[a-z0-9_-]+\.(js|css|woff2|svg|png|txt)$/
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.html': 'text/html; charset=utf-8' }
const INLINE = /^(image\/(png|jpeg|gif|webp|avif)|audio\/[\w.+-]+|video\/[\w.+-]+|application\/pdf)$/
const MIME = /^[a-z]+\/[a-z0-9.+-]{1,80}$/
const JSON_LIMIT = 64 * 1024
const FILE_ID = /^f[0-9a-f]{20}$/

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
    const why = guard.check(request, client, { browser: !enrolling })
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
    if (method === 'POST' && route === '/api/upload') return upload(request, response, url, need(request))
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
    if (method === 'POST' && enrolling) {
      const given = await body(request)
      const answer = nodes.enroll(given, client.address)
      return send(response, answer.status ?? 200, answer)
    }
    throw new HttpError(404, 'Nothing here.')
  }

  function file (response, where, cache = 'no-cache') {
    let data
    try { data = fs.readFileSync(where) } catch { throw new HttpError(404, 'No such file.') }
    response.writeHead(200, headers(response.req, { 'Content-Type': TYPES[path.extname(where)] || 'application/octet-stream',
      'Cache-Control': cache, 'Content-Length': data.length }))
    response.end(data)
  }

  async function upload (request, response, url, user) {
    const limit = hub.maxUploadMB * 1024 * 1024
    const declared = Number(request.headers['content-length'] || 0)
    if (declared > limit) throw new HttpError(413, `Files are at most ${hub.maxUploadMB} MB.`)
    const id = `f${crypto.randomBytes(10).toString('hex')}`
    const name = safeName(url.searchParams.get('name'))
    const type = String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
    const mime = MIME.test(type) ? type : 'application/octet-stream'
    const where = hub.store.filePath(id)
    let size = 0
    const counter = async function * (source) {
      for await (const chunk of source) {
        size += chunk.length
        if (size > limit) throw new HttpError(413, `Files are at most ${hub.maxUploadMB} MB.`)
        yield chunk
      }
    }
    try {
      await pipeline(request, counter, fs.createWriteStream(where, { flags: 'wx' }))
    } catch (error) {
      fs.rmSync(where, { force: true })
      throw error
    }
    const kept = hub.store.addFile({ id, name, mime, size, owner: user.id })
    return send(response, 200, { file: { id: kept.id, name: kept.name, mime: kept.mime, size: kept.size } })
  }

  function stored (request, response, found) {
    const where = hub.store.filePath(found.id)
    let stat
    try { stat = fs.statSync(where) } catch { throw new HttpError(404, 'That file is gone.') }
    const inline = INLINE.test(found.mime)
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
  return server
}
