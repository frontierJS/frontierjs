// src/signer.ts — `client_secret_basic` through conduit's signer seam (FJS-D891),
// and Apple's client secret, which is a JWT the app mints rather than a string
// it was given.
//
// The signer is installed on the `client` target alone (`oidcTargets`) and
// signs everything it is handed: the token endpoint, revocation and
// introspection. Discovery, JWKS and userinfo go through the `public` target,
// whose auth is `none` — the client secret is never sent where nothing reads
// it, and the user's Bearer on userinfo is never replaced by Basic, since a
// target's auth header wins over a caller's (FJS-2729).
//
// The credential rides the resolver's one string as `<client_id>:<client_secret>`.
// RFC 6749 §2.3.1: both halves are form-urlencoded BEFORE the Basic encoding,
// so a secret holding `:` or `%` survives; a sink that decodes it the same way
// is what proves it.

import type { CredentialResolver, Signer } from '@frontierjs/conduit'
import { importEs256Pkcs8, signJwt } from './jwt.ts'

export const OIDC_SIGNER = 'oidc-client-basic'

export interface ClientCredential { clientId: string; clientSecret: string }

/** `"<client_id>:<client_secret>"` → the pair. The id never holds a colon; the secret may. */
export function splitCredential(secret: string): ClientCredential {
  const i = secret.indexOf(':')
  if (i <= 0 || i === secret.length - 1) throw new Error('oidc: the credential must be "<client_id>:<client_secret>"')
  return { clientId: secret.slice(0, i), clientSecret: secret.slice(i + 1) }
}

export function basicHeader({ clientId, clientSecret }: ClientCredential): string {
  return `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}`
}

export const oidcClientBasic: Signer = ({ secret }) => ({ headers: { authorization: basicHeader(splitCredential(secret)) } })

export const oidcSigners = { [OIDC_SIGNER]: oidcClientBasic }

// ─── Apple ────────────────────────────────────────────────────────────────

export const APPLE_ISSUER = 'https://appleid.apple.com'
/** Apple's ceiling on a client secret's life. */
export const APPLE_SECRET_MAX_SECONDS = 15_777_000

export interface AppleClientSecretOptions {
  teamId:     string
  clientId:   string
  keyId:      string
  /** The `.p8` contents, PKCS#8 PEM. */
  privateKey: string
  /** Seconds the minted secret lives; Apple refuses more than six months. */
  ttlSeconds?: number
  /** Seconds. An argument so a drive can mint for a stated moment. */
  now?: () => number
}

/**
 * A resolver whose `get()` MINTS Apple's client secret — an ES256 JWT over the
 * team's key — and answers it in the Basic signer's spelling. Wrap it in
 * `withCache({ ttl_ms })` at or under the JWT's own life, since the cache is the
 * secret's expiry (conduit holds no credential lifetime). No vendor is called.
 *
 * Apple documents the secret as a `client_secret` POST parameter, which is
 * `client_secret_post`; whether its token endpoint also takes it as Basic is
 * unverified here (no key) and stated in `PROJECT_STATE.md`.
 */
export function appleClientSecretResolver(opts: AppleClientSecretOptions): CredentialResolver {
  const ttl = opts.ttlSeconds ?? 86_400
  if (ttl > APPLE_SECRET_MAX_SECONDS) throw new RangeError(`oidc: Apple refuses a client secret living more than ${APPLE_SECRET_MAX_SECONDS}s`)
  let key: Promise<CryptoKey> | null = null
  return {
    async get() {
      key ??= importEs256Pkcs8(opts.privateKey)
      const iat = Math.floor((opts.now ?? (() => Date.now() / 1000))())
      const jwt = await signJwt('ES256', await key, { kid: opts.keyId }, { iss: opts.teamId, iat, exp: iat + ttl, aud: APPLE_ISSUER, sub: opts.clientId })
      return `${opts.clientId}:${jwt}`
    },
  }
}
