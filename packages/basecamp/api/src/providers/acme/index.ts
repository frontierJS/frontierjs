// src/providers/acme/index.ts
// ACME (RFC 8555) by DNS-01, with nothing to install: WebCrypto signs, `fetch`
// speaks, and `node:crypto` reads the expiry off the certificate.
//
// The caller owns the zone. `issue()` never talks to a DNS vendor; it hands the
// TXT record to `dns.set`, asks the CA to look, and hands it back to `dns.clear`
// whether the order worked or not -- a challenge record left behind is a
// public, permanent claim on the name.
//
// Two names can share one TXT name: `example.test` and `*.example.test` both
// answer at `_acme-challenge.example.test`, with different values. `dns.set`
// therefore ADDS a record and `dns.clear(name, value)` removes the one value
// it is given; a `set` that replaced would fail one of the two authorizations.

import { X509Certificate } from 'node:crypto'
import { buildCsr, toPem }  from './csr.ts'

/** The CA's problem document (RFC 7807 as RFC 8555 § 6.7 uses it). `type` is
 *  the `urn:ietf:params:acme:error:*` string a caller branches on. */
export class AcmeError extends Error {
  type:        string
  detail:      string
  status:      number
  /** The name an invalid authorization was for; absent on other failures. */
  identifier?: string

  constructor(problem: { type?: string, detail?: string, status?: number }, identifier?: string) {
    const type   = problem.type   ?? 'about:blank'
    const detail = problem.detail ?? 'no detail given'
    super(identifier ? `${identifier}: ${type}: ${detail}` : `${type}: ${detail}`)
    this.name       = 'AcmeError'
    this.type       = type
    this.detail     = detail
    this.status     = problem.status ?? 0
    this.identifier = identifier
  }
}

export interface AcmeDns {
  /** Add a TXT record. Must not replace another value at the same name. */
  set:   (name: string, value: string) => Promise<void>
  /** Remove that one value. Called for every `set`, success or not. */
  clear: (name: string, value: string) => Promise<void>
}

export interface IssueOptions {
  directoryUrl: string
  /** A private P-256 JWK. Absent: an account is created and its key returned. */
  accountKey?:  JsonWebKey
  /** `['*.example.test']`, and the apex beside it if it is served too. */
  names:        string[]
  dns:          AcmeDns
  /** Injected so a test can trust a CA whose certificate is self-signed. */
  fetch?:       typeof fetch
  /** Runs between the last `dns.set` and the CA being told to look. A caller
   *  with a real resolver waits here for the record to be visible, because the
   *  CA asks once and an `invalid` authorization is not retried. */
  waitForDns?:  (records: { name: string, value: string }[]) => Promise<void>
  /** Bound on any one poll loop. Default two minutes. */
  timeoutMs?:   number
}

export interface Issued {
  /** PEM chain, leaf first. */
  cert:       string
  /** PEM PKCS#8. */
  key:        string
  accountKey: JsonWebKey
  /** ISO time, the leaf's notAfter. */
  expiresAt:  string
}

interface Problem  { type?: string, detail?: string, status?: number }
interface Challenge { type: string, url: string, token: string, status: string, error?: Problem }
interface Authorization {
  status:     string
  identifier: { type: string, value: string }
  wildcard?:  boolean
  challenges: Challenge[]
}
interface Order {
  status:         string
  authorizations: string[]
  finalize:       string
  certificate?:   string
  error?:         Problem
}

// ─── encoding ───────────────────────────────────────────────────────────────

const encoder = new TextEncoder()

function b64url(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data
  return Buffer.from(bytes).toString('base64url')
}

const sha256 = async (text: string) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))

const EC = { name: 'ECDSA', namedCurve: 'P-256' } as const

/** RFC 7638: the required members in lexicographic order, no whitespace. The
 *  CA computes the same string, so any other order or extra member makes a
 *  key authorization it rejects as a mismatch. */
async function thumbprint(jwk: JsonWebKey): Promise<string> {
  return b64url(await sha256(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })))
}

// ─── the protocol connection ────────────────────────────────────────────────

const BAD_NONCE_RETRIES = 4

class Acme {
  private nonce?: string
  private kid?:   string
  private dir!:   { newNonce: string, newAccount: string, newOrder: string }
  private signer!: CryptoKey

  constructor(
    private send: typeof fetch,
    private directoryUrl: string,
    private accountKey: JsonWebKey,
    private timeoutMs: number,
  ) {}

  async start() {
    this.signer = await crypto.subtle.importKey('jwk', this.accountKey, EC, false, ['sign'])
    const res = await this.send(this.directoryUrl)
    if (!res.ok) throw new AcmeError({ detail: `directory answered ${res.status}`, status: res.status })
    this.dir = await res.json() as typeof this.dir
  }

  private async freshNonce(): Promise<string> {
    const res = await this.send(this.dir.newNonce, { method: 'HEAD' })
    const nonce = res.headers.get('replay-nonce')
    if (!nonce) throw new AcmeError({ detail: 'newNonce answered with no Replay-Nonce' })
    return nonce
  }

  /** A signed POST. `payload` undefined is POST-as-GET (RFC 8555 § 6.3): an
   *  empty payload, which is not the same as `{}`. */
  async post(url: string, payload: unknown, opts: { jwk?: boolean } = {}) {
    for (let attempt = 0; ; attempt++) {
      const protectedHeader = {
        alg:   'ES256',
        nonce: this.nonce ?? await this.freshNonce(),
        url,
        ...(opts.jwk ? { jwk: publicOf(this.accountKey) } : { kid: this.kid }),
      }
      this.nonce = undefined

      const head = b64url(JSON.stringify(protectedHeader))
      const body = payload === undefined ? '' : b64url(JSON.stringify(payload))
      // WebCrypto's ECDSA output is already the raw r||s that JWS ES256 wants.
      const sig  = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.signer, encoder.encode(`${head}.${body}`)))

      const res = await this.send(url, {
        method:  'POST',
        headers: { 'content-type': 'application/jose+json' },
        body:    JSON.stringify({ protected: head, payload: body, signature: b64url(sig) }),
      })
      this.nonce = res.headers.get('replay-nonce') ?? undefined

      if (res.ok) return res

      const problem = await res.json().catch(() => ({})) as Problem
      // A CA may reject a nonce it issued (it expired or was evicted); the
      // error response carries a fresh one, so the same request is signed again.
      if (problem.type === 'urn:ietf:params:acme:error:badNonce' && attempt < BAD_NONCE_RETRIES) continue
      throw new AcmeError({ ...problem, status: problem.status ?? res.status })
    }
  }

  async postJson<T>(url: string, payload: unknown, opts: { jwk?: boolean } = {}): Promise<{ body: T, res: Response }> {
    const res = await this.post(url, payload, opts)
    return { body: await res.json() as T, res }
  }

  async account(): Promise<void> {
    const { res } = await this.postJson(this.dir.newAccount, { termsOfServiceAgreed: true }, { jwk: true })
    const kid = res.headers.get('location')
    if (!kid) throw new AcmeError({ detail: 'newAccount answered with no Location' })
    this.kid = kid
  }

  newOrder(names: string[]) {
    return this.postJson<Order>(this.dir.newOrder, { identifiers: names.map(value => ({ type: 'dns', value })) })
  }

  /** Re-read `url` until `done`, bounded by a deadline, waiting as long as the
   *  CA's Retry-After says (clamped so a hostile value cannot stall a caller). */
  async poll<T>(url: string, done: (body: T) => boolean): Promise<T> {
    const deadline = Date.now() + this.timeoutMs
    for (;;) {
      const { body, res } = await this.postJson<T>(url, undefined)
      if (done(body)) return body
      if (Date.now() >= deadline) throw new AcmeError({ detail: `${url} still pending after ${this.timeoutMs}ms` })
      const asked = Number(res.headers.get('retry-after'))
      const wait  = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 10) : 1
      await new Promise(resolve => setTimeout(resolve, wait * 1000))
    }
  }
}

/** The public half of a private EC JWK -- the members a `jwk` header may carry. */
function publicOf(jwk: JsonWebKey): JsonWebKey {
  return { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }
}

// ─── issue ──────────────────────────────────────────────────────────────────

export async function issue(options: IssueOptions): Promise<Issued> {
  const { directoryUrl, names, dns } = options
  if (!names.length) throw new Error('issue() needs at least one name')

  const accountKey: JsonWebKey = options.accountKey
    ?? await crypto.subtle.generateKey(EC, true, ['sign', 'verify'])
         .then(pair => crypto.subtle.exportKey('jwk', pair.privateKey) as Promise<JsonWebKey>)

  const acme = new Acme(options.fetch ?? fetch, directoryUrl, accountKey, options.timeoutMs ?? 120_000)
  await acme.start()
  await acme.account()

  const { body: order, res: orderRes } = await acme.newOrder(names)
  const orderUrl = orderRes.headers.get('location')
  if (!orderUrl) throw new AcmeError({ detail: 'newOrder answered with no Location' })

  const printed = await thumbprint(accountKey)

  // Every record is set before any is validated, and every one that was set is
  // cleared in the finally -- including when `set` itself threw halfway.
  const records: { name: string, value: string }[] = []
  const written: { name: string, value: string }[] = []
  const pending: { auth: Authorization, challenge: Challenge, url: string }[] = []

  try {
    for (const url of order.authorizations) {
      const { body: auth } = await acme.postJson<Authorization>(url, undefined)
      // The CA may reuse a recent valid authorization; asking it again for a
      // challenge on one would be refused.
      if (auth.status === 'valid') continue

      const challenge = auth.challenges.find(c => c.type === 'dns-01')
      if (!challenge) throw new AcmeError({ type: 'urn:ietf:params:acme:error:malformed', detail: 'no dns-01 challenge offered' }, auth.identifier.value)

      const name  = `_acme-challenge.${auth.identifier.value}`
      const value = b64url(await sha256(`${challenge.token}.${printed}`))
      records.push({ name, value })
      pending.push({ auth, challenge, url })
    }

    for (const record of records) {
      await dns.set(record.name, record.value)
      written.push(record)
    }
    if (records.length) await options.waitForDns?.(records)

    for (const { challenge } of pending) await acme.post(challenge.url, {})

    for (const { auth, url } of pending) {
      const done = await acme.poll<Authorization>(url, a => a.status !== 'pending' && a.status !== 'processing')
      if (done.status !== 'valid') {
        const failed = done.challenges.find(c => c.type === 'dns-01')?.error
        throw new AcmeError(failed ?? { detail: `authorization ${done.status}` }, auth.identifier.value)
      }
    }
  } finally {
    // A failed clear must not hide the order's own error, nor stop the rest.
    for (const record of written) await dns.clear(record.name, record.value).catch(() => {})
  }

  await acme.poll<Order>(orderUrl, o => o.status !== 'pending')

  const keys = await crypto.subtle.generateKey(EC, true, ['sign', 'verify']) as CryptoKeyPair
  const csr  = await buildCsr(names, keys)
  await acme.post(order.finalize, { csr: b64url(csr) })

  const ready = await acme.poll<Order>(orderUrl, o => o.status === 'valid' || o.status === 'invalid')
  if (ready.status === 'invalid') throw new AcmeError(ready.error ?? { detail: 'order invalid' })
  if (!ready.certificate) throw new AcmeError({ detail: 'order valid with no certificate URL' })

  const cert = await (await acme.post(ready.certificate, undefined)).text()
  const key  = toPem('PRIVATE KEY', new Uint8Array(await crypto.subtle.exportKey('pkcs8', keys.privateKey)))

  return {
    cert,
    key,
    accountKey,
    expiresAt: new Date(new X509Certificate(cert).validTo).toISOString(),
  }
}
