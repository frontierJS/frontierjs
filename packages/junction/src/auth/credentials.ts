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
import type { SessionContext } from './types.ts'

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
