// A credential that is not a bearer token, and the door it comes in by.
//
// Every `Authorization: Bearer` goes through `IAuth.verifySession`, and that was
// the only door: a machine proving itself with an HMAC over the request had no
// way to become a principal, so an app guarded each machine-facing method with
// a hook it had to remember to keep ahead of every new one (`FJS-371`, `FJS-349`
// is what happens when it is forgotten). `FJS-D475`: an ordered list of
// verifiers, tried by the transport before the bearer path.
//
//   createApp({ credentials: [signedRequest({ keyFor })] })

import { verifyRequest } from '@frontierjs/toolbelt/signature'
import type { IAuth, SessionContext } from './types.ts'

/** What a verifier is shown: the request as the signer signed it. */
export interface InboundRequest {
  method:  string
  path:    string
  /** The raw query string, `?` excluded. */
  query:   string
  headers: Record<string, string>
  /** The exact bytes received — a digest over a re-serialized body is not the one signed. */
  body:    string | Uint8Array
  host:    string | null
}

/**
 * A verifier's answer. `null` is *not mine* and the next one is asked; `REFUSE`
 * is *mine and wrong*, answered 401 at once. The two must differ, because a
 * forged signature that fell through to "anonymous" would reach every method a
 * stranger may call — the fail-open this door exists to close.
 */
export const REFUSE: unique symbol = Symbol.for('junction.credential.refuse') as never
export type CredentialAnswer   = SessionContext | null | typeof REFUSE
export type CredentialVerifier = (req: InboundRequest) => CredentialAnswer | Promise<CredentialAnswer>

export interface SignedRequestOptions {
  /**
   * Which caller, then which key. Answers the secret to verify against and the
   * principal a good signature becomes; `null` is a caller this app does not
   * know, and is refused rather than passed on.
   */
  keyFor: (req: InboundRequest) =>
    { secret: string | undefined; session: SessionContext } | null |
    Promise<{ secret: string | undefined; session: SessionContext } | null>
  /** Seconds a signature stays fresh. Default 300. */
  window?:    number
  /** Header prefix — `X-Fjs` reads `X-Fjs-Signature`. */
  prefix?:    string
  /** The replay half: true when this nonce was already used inside the window. */
  seenNonce?: (nonce: string) => boolean | Promise<boolean>
  /** Seconds, the receiver's clock. Injectable for tests. */
  now?:       () => number
}

/** A request signed with `@frontierjs/toolbelt/signature`'s `signRequest`. */
export function signedRequest(opts: SignedRequestOptions): CredentialVerifier {
  const prefix = opts.prefix ?? 'X-Fjs'
  const header = `${prefix}-Signature`.toLowerCase()
  const now    = opts.now ?? (() => Math.floor(Date.now() / 1000))
  return async function signedRequest(req) {
    // No signature header at all is not this credential; the bearer path may
    // still own the request. A signature header that fails is refused.
    if (!req.headers[header]) return null
    const key = await opts.keyFor(req)
    if (!key) return REFUSE
    const verdict = await verifyRequest({
      secret: key.secret, method: req.method, path: req.path, query: req.query,
      body: req.body, headers: req.headers, prefix,
      toleranceSeconds: opts.window ?? 300, now: now(),
      seenNonce: opts.seenNonce ?? null,
    })
    return verdict.ok ? key.session : REFUSE
  }
}

// ─── The one door ───────────────────────────────────────────────────────────

/**
 * Who is this caller, for HTTP and a WebSocket upgrade alike: the declared
 * verifiers in order, then the bearer token as the last entry. `REFUSE` is a
 * verifier that claimed the request and found it wrong, or threw — a broken key
 * lookup refused rather than skipped, since skipping reads as anonymous. A
 * bearer that throws propagates and one that answers null returns null, because
 * HTTP answers either anonymous and the app's socket closes 4001 on either
 * (`FJS-702`, `FJS-1830`) — the transport's to choose, per route.
 *
 * `verifyApiKey` is asked here, after `verifySession` answers null: a provider
 * that routes keys from inside its own `verifySession` costs one repeated
 * lookup on a token that was already bad, and one that does not no longer
 * leaves an issued key unusable.
 */
export async function resolvePrincipal(opts: {
  verifiers: readonly CredentialVerifier[] | undefined
  req:       InboundRequest
  auth?:     Pick<IAuth, 'verifySession'> & Partial<Pick<IAuth, 'verifyApiKey'>> | undefined
  token?:    string | null
}): Promise<SessionContext | null | typeof REFUSE> {
  for (const verify of opts.verifiers ?? []) {
    let answer: CredentialAnswer
    try { answer = await verify(opts.req) } catch { return REFUSE }
    if (answer === REFUSE) return REFUSE
    if (answer) return answer
  }
  if (!opts.auth || !opts.token) return null
  const origin = { host: opts.req.host, headers: opts.req.headers }
  const session = await opts.auth.verifySession(opts.token, origin)
  if (session) return session
  return opts.auth.verifyApiKey ? opts.auth.verifyApiKey(opts.token) : null
}
