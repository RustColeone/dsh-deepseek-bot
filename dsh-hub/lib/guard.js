// What every request to the hub passes before anything else (Chimera's web UI guard, carried over):
//
// 1. Who: with `access: 'lan'` (the default) only loopback, private, link-local and Tailscale (100.64.0.0/10,
//    fd7a:115c:a1e0::/48) addresses; `access: 'anywhere'` lets every address reach the sign-in page. Through a proxy
//    named in `trustProxy`, the client is the address it forwards.
// 2. Host: an IP address, localhost, a home-network name (.local, .lan, .home, .home.arpa, .internal), a Tailscale
//    name (.ts.net) or a name in `hostnames`. A public name that points here is a DNS-rebinding attempt by some website.
// 3. Origin: when a browser sends one it must be this page's own, so other sites open in the same browser can neither
//    post here nor open the websocket.
// 4. Headers on every answer: a strict Content-Security-Policy and friends.
import net from 'node:net'

const V4_LOCAL = [
  ['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['169.254.0.0', 16],
  ['100.64.0.0', 10], // carrier-grade NAT: Tailscale's addresses
]
const V6_LOCAL = [['::1', 128], ['fc00::', 7], ['fe80::', 10]] // fd7a:115c:a1e0::/48 (Tailscale) is inside fc00::/7
const HOME_SUFFIXES = ['.local', '.lan', '.home', '.home.arpa', '.internal', '.localdomain', '.ts.net']

const v4 = text => text.split('.').reduce((sum, part) => (sum << 8n) + BigInt(Number(part)), 0n)
function v6 (text) {
  let [head, tail] = text.split('::')
  const parts = head ? head.split(':') : []
  const rest = tail != null ? (tail ? tail.split(':') : []) : []
  if (rest.length && rest[rest.length - 1].includes('.')) { // an IPv4 tail
    const four = v4(rest.pop())
    rest.push(((four >> 16n) & 0xffffn).toString(16), (four & 0xffffn).toString(16))
  }
  const missing = 8 - parts.length - rest.length
  const all = [...parts, ...Array(tail != null ? missing : 0).fill('0'), ...rest]
  return all.reduce((sum, part) => (sum << 16n) + BigInt(parseInt(part || '0', 16)), 0n)
}
const inRange = (value, base, bits, width) => (value >> BigInt(width - bits)) === (base >> BigInt(width - bits))

/** The plain address, with IPv4-mapped IPv6 unwrapped and a zone dropped. */
export function plainAddress (address) {
  let text = String(address || '').replace(/%.*$/, '')
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(text)
  if (mapped) text = mapped[1]
  return text
}

export function isLocalAddress (address) {
  const text = plainAddress(address)
  if (net.isIPv4(text)) return V4_LOCAL.some(([base, bits]) => inRange(v4(text), v4(base), bits, 32))
  if (net.isIPv6(text)) return V6_LOCAL.some(([base, bits]) => inRange(v6(text), v6(base), bits, 128))
  return false
}

/** The host name without its port; IPv6 literals without their brackets. */
export function hostName (host) {
  const text = String(host || '').trim().toLowerCase()
  if (text.startsWith('[')) return text.slice(1, text.indexOf(']'))
  return text.replace(/:\d+$/, '')
}

export function isHomeHost (host, hostnames = []) {
  const name = hostName(host)
  if (!name) return false
  if (net.isIP(name) || name === 'localhost' || name.endsWith('.localhost')) return true
  if (hostnames.map(item => String(item).toLowerCase()).includes(name)) return true
  if (!name.includes('.')) return true // a bare machine name on the home network
  return HOME_SUFFIXES.some(suffix => name.endsWith(suffix))
}

export class Guard {
  /**
   * @param {object} options
   * @param {'lan'|'anywhere'} [options.access]
   * @param {string[]} [options.hostnames] extra names this hub is reached by (a domain of yours)
   * @param {string[]} [options.trustProxy] addresses of reverse proxies whose X-Forwarded-For/Proto to believe
   * @param {boolean} [options.tls] the hub itself serves https
   */
  constructor ({ access = 'lan', hostnames = [], trustProxy = [], tls = false, log = () => {} } = {}) {
    this.access = access
    this.hostnames = hostnames
    this.trustProxy = new Set(trustProxy.map(plainAddress))
    this.tls = tls
    this.log = log
    this.refusals = []
  }

  /** The client as far as the hub can tell: { address, local, secure, host }. */
  client (request) {
    const peer = plainAddress(request.socket.remoteAddress)
    let address = peer
    let secure = this.tls
    if (this.trustProxy.has(peer)) {
      const forwarded = String(request.headers['x-forwarded-for'] || '').split(',').map(part => part.trim()).filter(Boolean)
      if (forwarded.length) address = plainAddress(forwarded[forwarded.length - 1])
      const proto = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim()
      if (proto) secure = proto === 'https'
    }
    return { address, local: isLocalAddress(address), secure, host: String(request.headers.host || '') }
  }

  /** Why a request may not go on, or '' when it may. `browser`: the request comes from the page, not a node. */
  check (request, client, { browser = true } = {}) {
    if (this.access !== 'anywhere' && !client.local) return this.#refuse('address', request, client)
    if (browser && !isHomeHost(client.host, this.hostnames)) return this.#refuse('host', request, client)
    const origin = request.headers.origin
    if (browser && origin !== undefined) {
      const expected = `${client.secure ? 'https' : 'http'}://${client.host}`.toLowerCase()
      if (String(origin).toLowerCase() !== expected) return this.#refuse('origin', request, client)
    }
    return ''
  }

  #refuse (why, request, client) {
    const at = Date.now()
    this.refusals = this.refusals.filter(time => time > at - 60000)
    if (this.refusals.length < 20) {
      this.refusals.push(at)
      this.log('refused', { why, path: String(request.url).slice(0, 80), client: client.address,
        host: client.host.slice(0, 80), origin: String(request.headers.origin ?? '').slice(0, 80) })
    }
    return why
  }
}

export const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdn.jsdelivr.net/npm/katex@0.16.11/",
  "style-src 'self' https://cdn.jsdelivr.net/npm/katex@0.16.11/",
  "font-src 'self' https://cdn.jsdelivr.net/npm/katex@0.16.11/",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ')

export function securityHeaders (secure) {
  return {
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    ...(secure ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
  }
}
