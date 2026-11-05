// src/verify.ts — is this id_token really the provider's, and really for us?
//
// Pure: the JWKS, the expected issuer and audience and the clock are arguments,
// so a test can rotate a key or move time without a network. The reason is for
// the log and never for the response (CONTRACT C8).
//
// What is refused, by name, before any crypto runs:
//
//   - `alg: none`, and every HS* — an HMAC algorithm verified against a PUBLIC
//     key set is the classic confusion attack: the public key becomes the
//     shared secret and anyone holding the JWKS can mint a token.
//   - any `alg` outside RS256 / ES256, including a legitimate one the provider
//     advertises: the allow-list is this connector's, not the header's.
//   - a `kid` the JWKS does not hold. The result carries `unknownKid: true`,
//     which is the one signal `jwksResolver` reads to refetch once and no more
//     — a second miss is a token signed by a key the provider never published.
//
// Claims, in the order OIDC Core §3.1.3.7 lists them: `iss` exact; `aud` holds
// our client_id whether it is a string or an array; with several audiences
// `azp` must be present and be us; `exp`, `nbf` and `iat` with the stated skew;
// `nonce` when the caller handed one in. A back-channel logout token runs the
// same function under `profile: 'logout'` — the differences are the spec's:
// `events` required, `sub` or `sid` required, `nonce` FORBIDDEN, `exp` optional.

import { ALLOWED_ALGS, algFitsKey, importPublicJwk, parseJwt, verifySignature, type AllowedAlg } from './jwt.ts'
import type { IdClaims, Jwk, Jwks, LogoutClaims } from './types.ts'

export const DEFAULT_CLOCK_SKEW_SECONDS = 60
export const LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout'

export interface VerifyOptions {
  jwks:              Jwks
  issuer:            string
  /** Our client_id. */
  audience:          string
  nonce?:            string
  /** Seconds, from the verifier's clock. */
  now:               number
  clockSkewSeconds?: number
  /** Refuse a token whose `iat` is further back than this, where the app wants bounded replay. */
  maxAgeSeconds?:    number
  profile?:          'id' | 'logout'
}

export type Verified<C> =
  | { ok: true;  claims: C; kid: string | null; alg: AllowedAlg }
  | { ok: false; reason: string; unknownKid?: true }

const refuse = (reason: string, extra: { unknownKid?: true } = {}): Verified<never> => ({ ok: false, reason, ...extra })

export function verifyIdToken(jwt: string, opts: VerifyOptions): Promise<Verified<IdClaims>> {
  return verify(jwt, { ...opts, profile: opts.profile ?? 'id' }) as Promise<Verified<IdClaims>>
}

export function verifyLogoutToken(jwt: string, opts: Omit<VerifyOptions, 'nonce' | 'profile'>): Promise<Verified<LogoutClaims>> {
  return verify(jwt, { ...opts, profile: 'logout' }) as Promise<Verified<LogoutClaims>>
}

/** The key a header's `kid` names; with no `kid` and exactly one signing key, that one. */
export function selectKey(jwks: Jwks, kid: string | undefined, alg: AllowedAlg): Jwk | 'unknown' | 'ambiguous' {
  const keys = (jwks?.keys ?? []).filter(k => k.use === undefined || k.use === 'sig').filter(k => k.alg === undefined || k.alg === alg)
  if (kid !== undefined) return keys.find(k => k.kid === kid) ?? 'unknown'
  const fits = keys.filter(k => algFitsKey(alg, k))
  return fits.length === 1 ? fits[0] : fits.length === 0 ? 'unknown' : 'ambiguous'
}

async function verify(jwt: string, opts: VerifyOptions & { profile: 'id' | 'logout' }): Promise<Verified<Record<string, unknown>>> {
  const skew = opts.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS
  const parsed = parseJwt(jwt)
  if ('error' in parsed) return refuse(parsed.error)
  const { header, payload } = parsed

  // ─── the algorithm, by name ─────────────────────────────────────────────
  const alg = header.alg
  if (alg === 'none')            return refuse(`alg 'none' is refused: an unsigned token`)
  if (/^HS\d+$/.test(alg))       return refuse(`alg '${alg}' is refused: a shared-secret algorithm against a public key set`)
  if (!(ALLOWED_ALGS as readonly string[]).includes(alg))
    return refuse(`alg '${alg}' is not in the allow-list (${ALLOWED_ALGS.join(', ')})`)
  if (header.kid !== undefined && typeof header.kid !== 'string') return refuse('kid is not a string')

  // ─── freshness and addressing before the crypto ─────────────────────────
  const { now, profile } = opts
  if (payload.iss !== opts.issuer) return refuse(`iss is '${String(payload.iss)}', expected '${opts.issuer}'`)

  const aud = payload.aud
  const auds = typeof aud === 'string' ? [aud] : Array.isArray(aud) && aud.every(a => typeof a === 'string') ? aud as string[] : null
  if (!auds || auds.length === 0)    return refuse('aud is missing or not a string or array of strings')
  if (!auds.includes(opts.audience)) return refuse(`aud ${JSON.stringify(aud)} does not name this client '${opts.audience}'`)
  if (auds.length > 1) {
    if (payload.azp === undefined)       return refuse('aud names several audiences and azp is absent')
    if (payload.azp !== opts.audience)   return refuse(`azp is '${String(payload.azp)}', expected this client '${opts.audience}'`)
  } else if (payload.azp !== undefined && payload.azp !== opts.audience) {
    return refuse(`azp is '${String(payload.azp)}', expected this client '${opts.audience}'`)
  }

  const num = (name: string): number | null | 'bad' => {
    const v = payload[name]
    if (v === undefined) return null
    return typeof v === 'number' && Number.isFinite(v) ? v : 'bad'
  }
  const exp = num('exp'), nbf = num('nbf'), iat = num('iat')
  if (exp === 'bad' || nbf === 'bad' || iat === 'bad') return refuse('exp, nbf or iat is not a number')
  if (exp === null && profile === 'id') return refuse('exp is missing')
  if (exp !== null && now - skew >= exp) return refuse(`expired: exp ${exp} is ${now - exp}s past, skew is ${skew}s`)
  if (nbf !== null && nbf - skew > now) return refuse(`not yet valid: nbf ${nbf} is ${nbf - now}s ahead, skew is ${skew}s`)
  if (iat === null) return refuse('iat is missing')
  if (iat - skew > now) return refuse(`issued in the future: iat ${iat} is ${iat - now}s ahead, skew is ${skew}s`)
  if (opts.maxAgeSeconds !== undefined && now - iat > opts.maxAgeSeconds + skew)
    return refuse(`too old: issued ${now - iat}s ago, max age is ${opts.maxAgeSeconds}s`)

  if (profile === 'id') {
    if (typeof payload.sub !== 'string' || !payload.sub) return refuse('sub is missing')
    if (opts.nonce !== undefined && payload.nonce !== opts.nonce) return refuse('nonce does not match the one this login sent')
  } else {
    if (payload.nonce !== undefined) return refuse('a logout token carries a nonce; the spec forbids one')
    const events = payload.events
    if (!events || typeof events !== 'object' || !(LOGOUT_EVENT in (events as object))) return refuse(`events does not name ${LOGOUT_EVENT}`)
    if (typeof payload.jti !== 'string') return refuse('jti is missing')
    if (typeof payload.sub !== 'string' && typeof payload.sid !== 'string') return refuse('neither sub nor sid is present')
  }

  // ─── the key, then the signature ────────────────────────────────────────
  const picked = selectKey(opts.jwks, header.kid, alg as AllowedAlg)
  if (picked === 'unknown')   return refuse(header.kid === undefined ? 'the JWKS holds no key for this alg' : `kid '${header.kid}' is not in the JWKS`, { unknownKid: true })
  if (picked === 'ambiguous') return refuse('token names no kid and the JWKS holds several candidate keys')
  if (!algFitsKey(alg as AllowedAlg, picked)) return refuse(`kid '${picked.kid}' is a ${picked.kty} key; ${alg} needs ${alg === 'RS256' ? 'RSA' : 'EC P-256'}`)

  let key: CryptoKey
  try { key = await importPublicJwk(alg as AllowedAlg, picked) } catch { return refuse(`kid '${picked.kid}' does not import as a ${alg} key`) }
  if (!(await verifySignature(alg as AllowedAlg, key, parsed))) return refuse('signature does not verify')

  return { ok: true, claims: payload, kid: header.kid ?? null, alg: alg as AllowedAlg }
}
