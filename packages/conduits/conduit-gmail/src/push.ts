// src/push.ts — the Pub/Sub push envelope → `{ emailAddress, historyId }`. Pure.
//
// The notification carries no mail: only whose mailbox moved and to where.
// `historyId` arrived as a JSON NUMBER in one era and a STRING in the guide
// today; both are accepted and the answer is always the string, because a
// history id past 2^53 silently loses digits as a number. Malformed is null:
// the receiver acks and drops it, since a redelivery cannot fix bad JSON.
// What the app does with it — verify the bearer, dedupe by `messageId`, walk
// history — is the app's (CONTRACT C8, C12).

import type { PushEnvelope, PushNotification } from './types.ts'

export function decodePushEnvelope(body: unknown): PushNotification | null {
  const env = body as PushEnvelope | null
  const msg = env?.message
  if (!msg || typeof msg.data !== 'string') return null
  const messageId = msg.messageId ?? msg.message_id
  if (!messageId) return null
  try {
    const json = JSON.parse(Buffer.from(msg.data, 'base64').toString('utf8')) as { emailAddress?: unknown; historyId?: unknown }
    if (typeof json.emailAddress !== 'string' || !json.emailAddress) return null
    const h = json.historyId
    if (typeof h !== 'string' && typeof h !== 'number') return null
    if (typeof h === 'number' && !Number.isSafeInteger(h)) return null
    const historyId = typeof h === 'number' ? String(h) : h
    if (!/^\d+$/.test(historyId)) return null
    const publishTime = msg.publishTime ?? msg.publish_time
    return { emailAddress: json.emailAddress, historyId, messageId: String(messageId), ...(publishTime ? { publishTime } : {}) }
  } catch {
    return null
  }
}

// ─── The push's bearer ────────────────────────────────────────────────────
//
// Pub/Sub signs the push with an OIDC token for the subscription's service
// account: RS256 under Google's published keys, `iss` accounts.google.com,
// `aud` the hook URL, `email` the publisher, and `azp` the service account's
// own id. That last claim is why `verifyIdToken` from conduit-oidc cannot be
// used as is: OIDC Core says `azp`, when present, names the client, and the
// verifier refuses an `azp` that is not the audience — which every real push
// token has. The signature half is oidc's, imported as a package; the claims
// are this profile's, checked here.

import { ALLOWED_ALGS, algFitsKey, importPublicJwk, parseJwt, selectKey, verifySignature, type AllowedAlg, type Jwks } from '@frontierjs/conduit-oidc'
import type { CredentialResolver } from '@frontierjs/conduit'

/** Google issues both spellings. */
export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'] as const
export const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
export const DEFAULT_CLOCK_SKEW_SECONDS = 60

export interface PushClaims {
  iss:             string
  aud:             string
  sub:             string
  email?:          string
  email_verified?: boolean
  azp?:            string
  exp:             number
  iat:             number
}

export interface VerifyPushOptions {
  jwks:              Jwks
  /** What the subscription was told to put in `aud`: the hook URL. */
  audience:          string
  /** The one service account that may publish; none means any verified email. */
  publisher?:        string
  /** Seconds, from the verifier's clock. */
  now:               number
  clockSkewSeconds?: number
}

export type VerifiedPush =
  | { ok: true;  claims: PushClaims; kid: string | null }
  | { ok: false; reason: string; unknownKid?: true }

const refuse = (reason: string, extra: { unknownKid?: true } = {}): VerifiedPush => ({ ok: false, reason, ...extra })

export async function verifyPushBearer(jwt: string, opts: VerifyPushOptions): Promise<VerifiedPush> {
  const skew = opts.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS
  const parsed = parseJwt(jwt)
  if ('error' in parsed) return refuse(parsed.error)
  const { header, payload } = parsed

  const alg = header.alg
  if (alg === 'none')      return refuse(`alg 'none' is refused: an unsigned token`)
  if (/^HS\d+$/.test(alg)) return refuse(`alg '${alg}' is refused: a shared-secret algorithm against a public key set`)
  if (!(ALLOWED_ALGS as readonly string[]).includes(alg)) return refuse(`alg '${alg}' is not in the allow-list (${ALLOWED_ALGS.join(', ')})`)
  if (header.kid !== undefined && typeof header.kid !== 'string') return refuse('kid is not a string')

  if (typeof payload.iss !== 'string' || !(GOOGLE_ISSUERS as readonly string[]).includes(payload.iss)) return refuse(`iss is '${String(payload.iss)}', expected Google`)
  if (payload.aud !== opts.audience) return refuse(`aud '${String(payload.aud)}' is not this endpoint '${opts.audience}'`)
  const exp = payload.exp, iat = payload.iat
  if (typeof exp !== 'number' || typeof iat !== 'number') return refuse('exp or iat is missing or not a number')
  if (opts.now - skew >= exp) return refuse(`expired: exp ${exp} is ${opts.now - exp}s past, skew is ${skew}s`)
  if (iat - skew > opts.now)  return refuse(`issued in the future: iat ${iat} is ${iat - opts.now}s ahead`)
  if (typeof payload.sub !== 'string' || !payload.sub) return refuse('sub is missing')
  if (opts.publisher !== undefined && (payload.email !== opts.publisher || payload.email_verified !== true))
    return refuse(`email '${String(payload.email)}' is not the publisher '${opts.publisher}' with email_verified`)

  const picked = selectKey(opts.jwks, header.kid, alg as AllowedAlg)
  if (picked === 'unknown')   return refuse(header.kid === undefined ? 'the key set holds no key for this alg' : `kid '${header.kid}' is not in the key set`, { unknownKid: true })
  if (picked === 'ambiguous') return refuse('token names no kid and the key set holds several candidate keys')
  if (!algFitsKey(alg as AllowedAlg, picked)) return refuse(`kid '${picked.kid}' is not a key for ${alg}`)
  let key: CryptoKey
  try { key = await importPublicJwk(alg as AllowedAlg, picked) } catch { return refuse(`kid '${picked.kid}' does not import as a ${alg} key`) }
  if (!(await verifySignature(alg as AllowedAlg, key, parsed))) return refuse('signature does not verify')
  return { ok: true, claims: payload as unknown as PushClaims, kid: header.kid ?? null }
}

export interface PushVerifier {
  jwks():  Promise<Jwks | null>
  /** `verifyPushBearer` with the cached set, refetched ONCE on an unknown kid: Google rotates, and a second miss is a key Google never published. */
  verify(jwt: string, opts: Omit<VerifyPushOptions, 'jwks'>): Promise<VerifiedPush & { refetched?: true }>
}

/** `cached` is a resolver answering Google's certs as JSON under `ref`, already wrapped in `withCache`. */
export function pushVerifier(cached: CredentialResolver, ref = GOOGLE_CERTS_URL): PushVerifier {
  const jwks = async () => { const v = await cached.get(ref); return v ? JSON.parse(v) as Jwks : null }
  return {
    jwks,
    async verify(jwt, opts) {
      const first = await cached.get(ref)
      if (!first) return { ok: false, reason: 'the key set could not be fetched' }
      const v = await verifyPushBearer(jwt, { ...opts, jwks: JSON.parse(first) })
      if (v.ok || !v.unknownKid) return v
      cached.invalidate?.(ref, first)
      const second = await cached.get(ref)
      if (!second) return { ok: false, reason: `${v.reason}; the key set could not be refetched` }
      return { ...(await verifyPushBearer(jwt, { ...opts, jwks: JSON.parse(second) })), refetched: true }
    },
  }
}
