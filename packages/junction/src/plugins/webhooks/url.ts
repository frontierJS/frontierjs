// webhooks/url.ts
// Which destinations this app may send a signed request to.
//
// A webhook registration is a URL somebody else chose, and the app then makes
// an authenticated POST to it from inside the network. That is the SSRF
// primitive: `http://169.254.169.254/latest/meta-data/` is the cloud instance's
// own credentials and `http://localhost:8503/api/jobs/1/retry` is junction's
// own devtools job runner, both reachable from the app and from nowhere else
// (`FJS-681`).
//
// Refusing at registration is not enough on its own and the reason is DNS: a
// name that resolved to a public address when it was registered can resolve to
// `127.0.0.1` an hour later, so the check runs again before every attempt.
// What that still does not close is a rebind BETWEEN the check and the connect,
// which needs the socket pinned to the address that was graded — `fetch` gives
// no way to do that, so it is stated here rather than implied.

import { lookup } from 'node:dns/promises'
import { isIP }   from 'node:net'

export interface TargetPolicy {
  // A plaintext destination. Off by default: the delivery carries an HMAC over
  // the body, which authenticates it and hides nothing.
  allowHttp?:    boolean
  // A destination inside the network. Off by default — this is the whole of
  // the SSRF guard. A test with a receiver on localhost turns it on and says so.
  allowPrivate?: boolean
  // How long to wait for a hostname to resolve. Default 3s.
  lookupTimeoutMs?: number
}

export class WebhookTargetError extends Error {
  status = 400
  constructor(message: string) { super(message); this.name = 'WebhookTargetError' }
}

// The ranges an app can reach and the internet cannot. IPv4 as [first octet
// match, predicate] so the common case is one comparison.
function isPrivateV4(ip: string): boolean {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = p
  if (a === 0 || a === 10 || a === 127)             return true   // this host · private · loopback
  if (a === 169 && b === 254)                       return true   // link-local — the metadata service
  if (a === 172 && b >= 16 && b <= 31)              return true   // private
  if (a === 192 && b === 168)                       return true   // private
  if (a === 100 && b >= 64 && b <= 127)             return true   // carrier-grade NAT
  if (a === 198 && (b === 18 || b === 19))          return true   // benchmarking
  if (a === 192 && b === 0)                         return true   // IETF protocol assignments
  if (a >= 224)                                     return true   // multicast, reserved, broadcast
  return false
}

function isPrivateV6(ip: string): boolean {
  const s = ip.toLowerCase().split('%')[0]
  if (s === '::1' || s === '::' ) return true
  // An IPv4 address wearing a v6 coat — `::ffff:127.0.0.1` and the NAT64
  // prefix both reach v4, so they are graded as the v4 address they carry.
  // `new URL()` normalises the mapped form to hex (`::ffff:7f00:1`), so
  // matching only the dotted spelling accepts loopback written the other way.
  const mapped = /^(?:::ffff:|::|64:ff9b::)/.test(s) ? s.replace(/^(?:::ffff:|64:ff9b::|::)/, '') : null
  if (mapped) {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(mapped)) return isPrivateV4(mapped)
    const hex = mapped.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
    if (hex) {
      const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16)
      return isPrivateV4([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'))
    }
  }
  const head = s.split(':')[0]
  if (/^f[cd]/.test(head)) return true                    // fc00::/7 unique local
  if (/^fe[89ab]/.test(head)) return true                 // fe80::/10 link local
  if (/^ff/.test(head)) return true                       // ff00::/8 multicast
  return false
}

const isPrivateAddress = (ip: string): boolean =>
  isIP(ip) === 6 ? isPrivateV6(ip) : isPrivateV4(ip)

/**
 * Throws `WebhookTargetError` unless this app may POST to `raw`.
 * Called at registration and again before every delivery attempt.
 */
function withTimeout<T>(p: Promise<T>, ms: number, host: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new WebhookTargetError(`webhook host did not resolve within ${ms}ms: ${host}`)), ms)
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>
}

export async function assertDeliverableTarget(raw: string, policy: TargetPolicy = {}): Promise<URL> {
  let url: URL
  try { url = new URL(raw) }
  catch { throw new WebhookTargetError(`webhook url is not a URL: ${JSON.stringify(raw)}`) }

  // An allow-list of schemes, not a deny-list: `file:`, `gopher:` and `data:`
  // are each reachable from a deny-list somebody forgot to grow.
  const lookupTimeoutMs = policy.lookupTimeoutMs ?? 3_000
  const https = url.protocol === 'https:'
  const http  = url.protocol === 'http:'
  if (!https && !http)
    throw new WebhookTargetError(`webhook url must be http or https, not ${url.protocol.replace(':', '')}`)
  if (http && !policy.allowHttp)
    throw new WebhookTargetError('webhook url must be https — pass targets: { allowHttp: true } to send in plaintext')

  if (policy.allowPrivate) return url

  const host = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(host)
    ? [host]
    // Every address the name answers with, not the first: a name resolving to
    // one public and one loopback address is refused, because which one the
    // connect picks is not this code's decision.
    //
    // Bounded, because this runs before EVERY attempt and `dns.lookup` has no
    // timeout of its own — it occupies a libuv thread pool slot until the
    // resolver answers, and the pool is four threads, so a hung resolver would
    // stall unrelated file I/O across the process rather than just this
    // delivery. The fetch's own `AbortSignal.timeout` is downstream of here.
    : (await withTimeout(
        lookup(host, { all: true }).catch(() => { throw new WebhookTargetError(`webhook host does not resolve: ${host}`) }),
        lookupTimeoutMs, host)).map(a => a.address)

  if (!addresses.length) throw new WebhookTargetError(`webhook host does not resolve: ${host}`)
  const priv = addresses.find(isPrivateAddress)
  if (priv)
    throw new WebhookTargetError(
      `webhook url resolves to a non-public address (${host} → ${priv}) — pass targets: { allowPrivate: true } if that is deliberate`)

  return url
}
