// core/public-url.ts
// Whether this server may send a request to a URL somebody else chose.
//
// A webhook registration, a pasted link to capture, a feed to poll: each is a
// URL a stranger picked, fetched from inside the network. That is the SSRF
// primitive: `http://169.254.169.254/latest/meta-data/` is the cloud instance's
// own credentials and `http://localhost:8503/api/jobs/1/retry` is junction's
// own devtools job runner, both reachable from the app and from nowhere else
// (`FJS-681`). An app that fetches such a URL calls this rather than writing
// its own ranges, because the copy is where the hole was (`FJS-1578`).
//
// Refusing once is not enough on its own and the reason is DNS: a name that
// resolved to a public address when it was saved can resolve to `127.0.0.1` an
// hour later, so a caller runs this again before every request, and again on
// every redirect hop. What that still does not close is a rebind BETWEEN the
// check and the connect, which needs the socket pinned to the address that was
// graded — `fetch` gives no way to do that, so it is stated here rather than
// implied.

import { lookup } from 'node:dns/promises'
import { isIP }   from 'node:net'

export interface PublicUrlPolicy {
  // A plaintext destination. Off by default: a webhook delivery carries an
  // HMAC over the body, which authenticates it and hides nothing.
  allowHttp?:    boolean
  // A destination inside the network. Off by default — this is the whole of
  // the SSRF guard. A test with a receiver on localhost turns it on and says so.
  allowPrivate?: boolean
  // How long to wait for a hostname to resolve. Default 3s.
  lookupTimeoutMs?: number
}

// Messages name the host and never the policy key: a caller shows them to the
// person who pasted the URL, who has no config to change.
export class PublicUrlError extends Error {
  status = 400
  constructor(message: string) { super(message); this.name = 'PublicUrlError' }
}

// Loopback, this host, private, carrier-grade NAT, link-local (the metadata
// service), IETF assignments, the documentation and benchmark nets, multicast
// and everything reserved above it.
const V4_BLOCKED: [number, number][] = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16],
  [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24], [0xc0a80000, 16], [0xc6120000, 15],
  [0xc6336400, 24], [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4],
]

function isPrivateV4(ip: string): boolean {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const n = ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0
  return V4_BLOCKED.some(([net, bits]) => (n >>> (32 - bits)) === (net >>> (32 - bits)))
}

// The eight 16-bit words, whatever the spelling. Matching v6 by string prefix
// is what let `::ffff:7f00:1` through — the same address has many spellings
// and `new URL()` picks one the caller did not write — so it is graded as
// numbers. Null for something `isIP` passed that this cannot read, which the
// caller treats as private.
function v6Words(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0]
  const dotted = s.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number)
    s = s.slice(0, -dotted[0].length) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16)
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  if (fill < 0) return null
  const words = [...head, ...Array(fill).fill('0'), ...tail].map(w => /^[0-9a-f]{1,4}$/.test(w) ? parseInt(w, 16) : -1)
  return words.length === 8 && words.every(w => w >= 0) ? words : null
}

function isPrivateV6(ip: string): boolean {
  const w = v6Words(ip)
  if (!w) return true
  const zero = (from: number, to: number) => w.slice(from, to).every(x => x === 0)
  // An IPv4 address wearing a v6 coat reaches v4, so it is graded as the v4
  // address it carries: IPv4-compatible (`::a.b.c.d`, and `::1` and `::` with
  // it), mapped (`::ffff:a.b.c.d`), SIIT-translated (`::ffff:0:a.b.c.d`), the
  // NAT64 well-known prefix, and 6to4, which carries it in words 1-2.
  const v4 = (i: number) => isPrivateV4(`${w[i] >> 8}.${w[i] & 255}.${w[i + 1] >> 8}.${w[i + 1] & 255}`)
  if (zero(0, 6))                                        return v4(6)
  if (zero(0, 5) && w[5] === 0xffff)                     return v4(6)
  if (zero(0, 4) && w[4] === 0xffff && w[5] === 0)       return v4(6)
  if (w[0] === 0x64 && w[1] === 0xff9b)                  return zero(2, 6) ? v4(6) : true   // 64:ff9b:1::/48 is local-use
  if (w[0] === 0x2002)                                   return v4(1)
  if (w[0] === 0x2001 && (w[1] === 0 || w[1] === 0xdb8)) return true    // Teredo · documentation
  if (w[0] === 0x100 && zero(1, 4))                      return true    // 100::/64 discard
  if ((w[0] & 0xfe00) === 0xfc00)                        return true    // fc00::/7 unique local
  if ((w[0] & 0xff80) === 0xfe80)                        return true    // fe80::/10 link local · fec0::/10 site local
  if ((w[0] & 0xff00) === 0xff00)                        return true    // ff00::/8 multicast
  return false
}

const isPrivateAddress = (ip: string): boolean => {
  const v = isIP(ip)
  return v === 4 ? isPrivateV4(ip) : v === 6 ? isPrivateV6(ip) : true
}

function withTimeout<T>(p: Promise<T>, ms: number, host: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PublicUrlError(`${host} did not resolve within ${ms}ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>
}

/**
 * Throws `PublicUrlError` unless this server may send a request to `raw`, and
 * answers the parsed URL. Run it before every request, and on every redirect
 * hop with the redirect's own URL.
 */
export async function assertPublicUrl(raw: string | URL, policy: PublicUrlPolicy = {}): Promise<URL> {
  let url: URL
  try { url = new URL(raw) }
  catch { throw new PublicUrlError(`not a URL: ${JSON.stringify(String(raw))}`) }

  // An allow-list of schemes, not a deny-list: `file:`, `gopher:` and `data:`
  // are each reachable from a deny-list somebody forgot to grow.
  const lookupTimeoutMs = policy.lookupTimeoutMs ?? 3_000
  const https = url.protocol === 'https:'
  const http  = url.protocol === 'http:'
  if (!https && !http)
    throw new PublicUrlError(`url must be http or https, not ${url.protocol.replace(':', '')}`)
  if (http && !policy.allowHttp)
    throw new PublicUrlError('url must be https')

  if (policy.allowPrivate) return url

  const host = url.hostname.replace(/^\[|\]$/g, '')
  const literal = isIP(host) !== 0
  const addresses = literal
    ? [host]
    // Every address the name answers with, not the first: a name resolving to
    // one public and one loopback address is refused, because which one the
    // connect picks is not this code's decision.
    //
    // Bounded, because this runs before EVERY request and `dns.lookup` has no
    // timeout of its own — it occupies a libuv thread pool slot until the
    // resolver answers, and the pool is four threads, so a hung resolver would
    // stall unrelated file I/O across the process rather than just this
    // request. The fetch's own `AbortSignal.timeout` is downstream of here.
    : (await withTimeout(
        lookup(host, { all: true }).catch(() => { throw new PublicUrlError(`${host} does not resolve`) }),
        lookupTimeoutMs, host)).map(a => a.address)

  if (!addresses.length) throw new PublicUrlError(`${host} does not resolve`)
  const priv = addresses.find(isPrivateAddress)
  if (priv)
    throw new PublicUrlError(literal ? `${host} is a private address` : `${host} resolves to a private address (${priv})`)

  return url
}
