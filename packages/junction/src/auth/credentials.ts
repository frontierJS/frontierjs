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

import { verifyRequest, nonceMemory } from '@frontierjs/toolbelt/signature'
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
   *
   * What the key was issued with goes on that session: the tenant claim the
   * schema names (`agencyId`) scopes rows under `strategy row`, and a standing
   * field (`memberRole`) reaches the gate and the policies. A `principal`
   * resolver that answers nothing for the key leaves both standing
   * (`test/credentials-claims.test.ts`).
   */
  keyFor: (req: InboundRequest) =>
    { secret: string | undefined; session: SessionContext } | null |
    Promise<{ secret: string | undefined; session: SessionContext } | null>
  /** Seconds a signature stays fresh. Default 300. */
  window?:    number
  /** Header prefix — `X-Fjs` reads `X-Fjs-Signature`. */
  prefix?:    string
  /**
   * The replay half: true when this nonce was already used inside the window.
   * Default is an in-process memory per caller, kept twice the window — enough
   * for one process; a fleet of them passes a shared store.
   */
  seenNonce?: (nonce: string) => boolean | Promise<boolean>
  /** Seconds, the receiver's clock. Injectable for tests. */
  now?:       () => number
}

/** A request signed with `@frontierjs/toolbelt/signature`'s `signRequest`. */
export function signedRequest(opts: SignedRequestOptions): CredentialVerifier {
  const prefix = opts.prefix ?? 'X-Fjs'
  const header = `${prefix}-Signature`.toLowerCase()
  const now    = opts.now ?? (() => Math.floor(Date.now() / 1000))
  const window = opts.window ?? 300
  // Refused at boot: verifyRequest refuses it per request, which is a 500 on
  // every signed call instead of one error at startup.
  if (!Number.isFinite(window) || window < 0)
    throw new TypeError('signedRequest: window must be a finite number of seconds, zero or more')
  // Without a memory a captured request replays for the whole window, and a
  // WebSocket upgrade authenticates every frame after it, whatever method each
  // frame names. TWICE the window, because a timestamp accepted at the limit
  // ahead of this clock stays fresh for another full window (FJS-1833). Keyed
  // by caller, so one machine's nonce cannot refuse another's.
  const seen = nonceMemory()
  const remember = (caller: string) => (nonce: string): boolean =>
    seen(`${caller}\n${nonce}`, now(), 2 * window)
  return async function signedRequest(req) {
    // No signature header at all is not this credential; the bearer path may
    // still own the request. A signature header that fails is refused.
    if (!req.headers[header]) return null
    const key = await opts.keyFor(req)
    if (!key) return REFUSE
    const verdict = await verifyRequest({
      secret: key.secret, method: req.method, path: req.path, query: req.query,
      body: req.body, headers: req.headers, prefix,
      toleranceSeconds: window, now: now(),
      seenNonce: opts.seenNonce ?? remember(String(key.session.id)),
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
export async function resolvePrincipal(opts: ResolveOptions): Promise<SessionContext | null | typeof REFUSE> {
  return (await resolveCaller(opts)).principal
}

type BearerAuth = Pick<IAuth, 'verifySession'> & Partial<Pick<IAuth, 'verifyApiKey'>>

interface ResolveOptions {
  verifiers: readonly CredentialVerifier[] | undefined
  req:       InboundRequest
  auth?:     BearerAuth | undefined
  token?:    string | null
}

/**
 * `resolvePrincipal`, saying also whether the bearer token is what answered.
 * That half is the one a socket may ask again (`FJS-D1201`): a verifier is
 * shown the upgrade request, and `signedRequest` refuses its nonce a second time.
 */
export async function resolveCaller(opts: ResolveOptions): Promise<{
  principal: SessionContext | null | typeof REFUSE
  bearer:    boolean
}> {
  for (const verify of opts.verifiers ?? []) {
    let answer: CredentialAnswer
    try { answer = await verify(opts.req) } catch { return { principal: REFUSE, bearer: false } }
    if (answer === REFUSE) return { principal: REFUSE, bearer: false }
    if (answer) return { principal: answer, bearer: false }
  }
  if (!opts.auth || !opts.token) return { principal: null, bearer: false }
  return { principal: await bearerPrincipal(opts.auth, opts.token, opts.req), bearer: true }
}

/** The bearer token alone — a session, else an API key. */
export async function bearerPrincipal(
  auth:  BearerAuth,
  token: string,
  req:   Pick<InboundRequest, 'host' | 'headers'>,
): Promise<SessionContext | null> {
  const session = await auth.verifySession(token, { host: req.host, headers: req.headers })
  if (session) return session
  return auth.verifyApiKey ? auth.verifyApiKey(token) : null
}
