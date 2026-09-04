// ============================================================
// Junction — Which address do we believe?
//
// `X-Forwarded-For` is a list the CLIENT can start. nginx's own template —
// the one this framework ships — writes `$proxy_add_x_forwarded_for`, which
// APPENDS the address it observed to whatever the client already sent. So the
// leftmost entry is the client's claim and the rightmost is what the nearest
// proxy actually saw, and reading the leftmost hands every IP-keyed decision
// to the caller: measured, five requests with five forged headers counted as
// five distinct clients against the rate limiter and the DDoS guard
// (`FJS-744`).
//
// The chain is read RIGHT to LEFT, and where to stop is the operator's
// statement about their own infrastructure — it cannot be discovered, because
// every entry left of the trusted boundary is an unverified string.
// ============================================================

/**
 * How many proxies stand in front of this app, or which ones.
 *
 *   false        the socket address, and nothing else. The default.
 *   true         one trusted hop — the shipped nginx template's shape.
 *   <n>          n trusted hops.
 *   [...]        trusted proxies by address or CIDR, IPv4 and IPv6.
 *
 * The number is the common answer and the list is the honest one: a hop count
 * is a promise about how many proxies are in front, which is wrong the moment
 * a load balancer is added, whereas a list is checked against what the socket
 * actually reports.
 */
export type TrustProxy = boolean | number | string[]

/**
 * The address to key rate limiting, DDoS protection and audit rows on.
 *
 * `remoteAddr` is the only value in here the client cannot forge; everything
 * else is a header. Where nothing is trusted, that is the answer.
 */
export function clientAddress(opts: {
  forwarded?:  string | null
  realIp?:     string | null
  remoteAddr?: string
  trust?:      TrustProxy
}): string {
  const trust  = opts.trust ?? false
  const socket = opts.remoteAddr?.trim() || ''

  if (trust === false || trust === 0) return socket || FALLBACK

  const entries = (opts.forwarded ?? '')
    .split(',')
    .map(entry => normalise(entry))
    .filter(Boolean)

  // The socket address is the last hop and the only observed one, so it
  // belongs on the end of the chain rather than beside it. Without it a
  // request that arrived with no `X-Forwarded-For` at all has nothing to
  // resolve against.
  const chain = socket ? [...entries, normalise(socket)] : entries
  if (chain.length === 0) return FALLBACK

  // The proxy immediately in front of us. A header only means anything once
  // that one is trusted.
  const peerTrusted = Array.isArray(trust)
    ? isTrusted(chain[chain.length - 1]!, trust)
    : true

  if (!peerTrusted) return chain[chain.length - 1]!

  // `X-Real-IP` is a single value the nearest proxy overwrote — the shipped
  // template sets it to `$remote_addr` — so it says what that proxy observed
  // and nothing about hops beyond it. Consulted only when there is no chain to
  // read, because with one the chain is the better answer and a client can
  // send this header too.
  if (entries.length === 0) {
    const real = normalise(opts.realIp ?? '')
    if (real) return real
    return chain[chain.length - 1]!
  }

  if (Array.isArray(trust)) {
    // Walk left while the entry is a proxy we put there. The first address
    // that is not one of ours is the furthest we can vouch for; everything
    // left of it was written by somebody we do not control.
    for (let i = chain.length - 1; i >= 0; i--) {
      if (!isTrusted(chain[i]!, trust)) return chain[i]!
    }
    // Every hop is one of ours, so the leftmost is as far back as the chain
    // goes — a request that originated inside the trusted network.
    return chain[0]!
  }

  // A hop count. `true` is one, which is the shipped template. Clamped rather
  // than wrapped: a chain shorter than the declared hops means a proxy did not
  // write its header, and the safe answer there is the furthest LEFT entry we
  // have, never an index that falls off the end.
  const hops  = trust === true ? 1 : Math.max(0, Math.floor(trust))
  const index = Math.max(0, chain.length - 1 - hops)
  return chain[index]!
}

// Only reached when there is no socket address and no usable header — a mock
// server or an in-process test.
const FALLBACK = '127.0.0.1'

// ─── Trusted-proxy matching ───────────────────────────────────────────────

function isTrusted(address: string, list: string[]): boolean {
  for (const entry of list) {
    if (matches(address, entry)) return true
  }
  return false
}

function matches(address: string, entry: string): boolean {
  const slash = entry.indexOf('/')
  if (slash === -1) return normalise(entry) === address

  const bits = Number(entry.slice(slash + 1))
  if (!Number.isInteger(bits) || bits < 0) return false

  const network = toBytes(normalise(entry.slice(0, slash)))
  const candidate = toBytes(address)
  if (!network || !candidate) return false
  // A v4 prefix says nothing about a v6 address and the other way round.
  if (network.length !== candidate.length) return false
  if (bits > network.length * 8) return false

  const whole = bits >> 3
  for (let i = 0; i < whole; i++) {
    if (network[i] !== candidate[i]) return false
  }
  const rest = bits & 7
  if (rest === 0) return true
  const mask = 0xff << (8 - rest) & 0xff
  return (network[whole]! & mask) === (candidate[whole]! & mask)
}

/**
 * One spelling per address, so a comparison is a string comparison.
 *
 * Three things happen here and each is a real answer a runtime gives: a
 * bracketed literal (`[::1]:443`), a port on a v4 address, and the
 * IPv4-mapped form (`::ffff:10.0.0.5`) — which Bun reports on a dual-stack
 * listener, and which would otherwise never match the `10.0.0.0/8` an
 * operator wrote.
 */
function normalise(value: string): string {
  let out = value.trim()
  if (!out) return ''

  if (out.startsWith('[')) {
    const close = out.indexOf(']')
    if (close !== -1) out = out.slice(1, close)
  } else if (out.split(':').length === 2) {
    // Exactly one colon is host:port; more than one is IPv6.
    out = out.slice(0, out.indexOf(':'))
  }

  out = out.toLowerCase()
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(out)
  return mapped ? mapped[1]! : out
}

function toBytes(address: string): number[] | null {
  if (address.includes('.') && !address.includes(':')) {
    const parts = address.split('.')
    if (parts.length !== 4) return null
    const bytes = parts.map(Number)
    if (bytes.some(b => !Number.isInteger(b) || b < 0 || b > 255)) return null
    return bytes
  }
  return v6Bytes(address)
}

function v6Bytes(address: string): number[] | null {
  if (!address.includes(':')) return null

  const halves = address.split('::')
  if (halves.length > 2) return null

  const expand = (part: string) => (part === '' ? [] : part.split(':'))
  const head = expand(halves[0]!)
  const tail = halves.length === 2 ? expand(halves[1]!) : []

  const groups = halves.length === 2
    ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail]
    : head
  if (groups.length !== 8) return null

  const bytes: number[] = []
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null
    const value = parseInt(group, 16)
    bytes.push(value >> 8, value & 0xff)
  }
  return bytes
}
