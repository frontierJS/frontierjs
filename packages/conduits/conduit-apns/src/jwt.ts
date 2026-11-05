// src/jwt.ts -- the ES256 JWS Apple's provider token is, over WebCrypto.
//
// The `.p8` arrives as PKCS8 PEM and is imported non-extractable. A JWS ECDSA
// signature is the raw `r || s` pair, which is what WebCrypto's ECDSA `sign`
// produces -- a DER-wrapped signature here is `InvalidProviderToken` with
// nothing in the response saying why.

const encoder = new TextEncoder()

export const b64url = (input: Uint8Array | ArrayBuffer | string): string =>
  Buffer.from(input instanceof ArrayBuffer ? new Uint8Array(input) : input).toString('base64url')

export const fromB64url = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64url'))

/** PEM text -> DER bytes. */
export function pemToDer(pem: string): ArrayBuffer {
  const body = pem.replace(/-----(BEGIN|END)[^-]+-----/g, '').replace(/\s+/g, '')
  if (!body) throw new TypeError('apns: the private key is not PEM')
  const bytes = Buffer.from(body, 'base64')
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

export function importPrivateKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', pemToDer(pem), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
}

export async function signJwt(header: Record<string, unknown>, payload: Record<string, unknown>, key: CryptoKey): Promise<string> {
  const signingInput = `${b64url(JSON.stringify({ alg: 'ES256', ...header }))}.${b64url(JSON.stringify(payload))}`
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(signingInput))
  return `${signingInput}.${b64url(sig)}`
}

/** The two JSON halves of a compact JWS, unverified -- for reading what went on the wire. */
export function decodeJwt(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [h, p] = token.split('.')
  return { header: JSON.parse(Buffer.from(fromB64url(h)).toString()), payload: JSON.parse(Buffer.from(fromB64url(p)).toString()) }
}
