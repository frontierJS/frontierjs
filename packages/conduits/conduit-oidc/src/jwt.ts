// src/jwt.ts — JWS compact serialization over WebCrypto, both directions.
//
// Written here rather than taken from a library because the verifier's whole
// value is the list of what it REFUSES, and a library's `verify(jwt, key)` has
// its own idea of which algorithms are acceptable. Two algorithms are allowed
// by name; every other `alg` is a refusal that names it. The signing half
// exists for the sink and for Apple's client secret, which is an ES256 JWT the
// app mints.

import type { Jwk } from './types.ts'

export const ALLOWED_ALGS = ['RS256', 'ES256'] as const
export type AllowedAlg = typeof ALLOWED_ALGS[number]

export interface JwsHeader { alg: string; kid?: string; typ?: string; [k: string]: unknown }

export interface ParsedJwt {
  header:  JwsHeader
  payload: Record<string, unknown>
  /** `<header>.<payload>` as received — what the signature is over. */
  signingInput: string
  signature:    Uint8Array
}

const enc = new TextEncoder()
const dec = new TextDecoder()

export function b64url(bytes: Uint8Array | ArrayBuffer | string): string {
  const u8 = typeof bytes === 'string' ? enc.encode(bytes) : bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes
  return Buffer.from(u8).toString('base64url')
}

export function unb64url(text: string): Uint8Array {
  // Strict: a padding character or a non-alphabet byte is a malformed token,
  // not something to repair. Buffer would decode it silently.
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('not base64url')
  return new Uint8Array(Buffer.from(text, 'base64url'))
}

/** Splits and decodes without trusting anything; the signature is NOT checked here. */
export function parseJwt(jwt: string): ParsedJwt | { error: string } {
  if (typeof jwt !== 'string') return { error: 'token is not a string' }
  const parts = jwt.split('.')
  // A JWE has five segments. It is refused here as a shape rather than
  // decrypted: an encrypted id_token is a feature nothing here asked for.
  if (parts.length !== 3) return { error: `token has ${parts.length} segments, a JWS has 3` }
  const [h, p, s] = parts
  try {
    const header  = JSON.parse(dec.decode(unb64url(h)))
    const payload = JSON.parse(dec.decode(unb64url(p)))
    if (!header || typeof header !== 'object' || typeof header.alg !== 'string') return { error: 'header has no alg' }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { error: 'payload is not an object' }
    return { header, payload, signingInput: `${h}.${p}`, signature: unb64url(s) }
  } catch {
    return { error: 'token is not base64url JSON' }
  }
}

const PARAMS: Record<AllowedAlg, { import: RsaHashedImportParams | EcKeyImportParams; verify: AlgorithmIdentifier | EcdsaParams }> = {
  RS256: { import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, verify: { name: 'RSASSA-PKCS1-v1_5' } },
  ES256: { import: { name: 'ECDSA', namedCurve: 'P-256' },        verify: { name: 'ECDSA', hash: 'SHA-256' } },
}

/** The key type an algorithm needs. A JWK of the other type is a refusal, not a cast. */
export function algFitsKey(alg: AllowedAlg, jwk: Jwk): boolean {
  if (alg === 'RS256') return jwk.kty === 'RSA' && typeof jwk.n === 'string' && typeof jwk.e === 'string'
  return jwk.kty === 'EC' && jwk.crv === 'P-256' && typeof jwk.x === 'string' && typeof jwk.y === 'string'
}

export async function importPublicJwk(alg: AllowedAlg, jwk: Jwk): Promise<CryptoKey> {
  // Only the public members cross: a JWKS that leaked a private `d` must not
  // turn a verifier into something that can sign.
  const pub: JsonWebKey = jwk.kty === 'RSA'
    ? { kty: 'RSA', n: jwk.n, e: jwk.e }
    : { kty: 'EC', crv: jwk.crv, x: jwk.x, y: jwk.y }
  return crypto.subtle.importKey('jwk', pub, PARAMS[alg].import, false, ['verify'])
}

export async function verifySignature(alg: AllowedAlg, key: CryptoKey, parsed: ParsedJwt): Promise<boolean> {
  try {
    return await crypto.subtle.verify(PARAMS[alg].verify, key, parsed.signature as BufferSource, enc.encode(parsed.signingInput))
  } catch {
    return false
  }
}

// ─── signing — the sink's half, and Apple's client secret ─────────────────

export async function signJwt(alg: AllowedAlg, key: CryptoKey, header: Omit<JwsHeader, 'alg'>, payload: Record<string, unknown>): Promise<string> {
  const input = `${b64url(JSON.stringify({ alg, ...header }))}.${b64url(JSON.stringify(payload))}`
  const sig   = await crypto.subtle.sign(PARAMS[alg].verify, key, enc.encode(input))
  return `${input}.${b64url(sig)}`
}

export async function generateKeyPair(alg: AllowedAlg): Promise<CryptoKeyPair> {
  return alg === 'RS256'
    ? crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
    : crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
}

export async function publicJwk(alg: AllowedAlg, pair: CryptoKeyPair, kid: string): Promise<Jwk> {
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey) as Jwk
  const { kty, n, e, crv, x, y } = jwk
  return { kty, kid, use: 'sig', alg, ...(n ? { n, e } : { crv, x, y }) }
}

/** A PKCS#8 PEM (`-----BEGIN PRIVATE KEY-----`, what Apple's `.p8` holds) → an ES256 signing key. */
export async function importEs256Pkcs8(pem: string): Promise<CryptoKey> {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '')
  return crypto.subtle.importKey('pkcs8', Buffer.from(body, 'base64'), PARAMS.ES256.import, false, ['sign'])
}
