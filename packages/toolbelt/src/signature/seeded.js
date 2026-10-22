// seeded.js — a key pair made from 32 bytes rather than drawn, for
// `generateSigningKeys` and `/seal`'s `generateSealingKeys` alike, so a key
// written down as words is the same key when typed back. Not an entry: both
// kits reach it by path.

/** RFC 8410's PKCS#8 wrapping of a 32-byte private key, less the key. */
const PKCS8 = {
  Ed25519: '302e020100300506032b657004220420',
  X25519:  '302e020100300506032b656e04220420',
}
const USAGES = { Ed25519: ['sign'], X25519: ['deriveBits'] }

/**
 * `{ publicKey, privateKey }` base64url, the shape both generators answer.
 * WebCrypto derives no public key from a private one, but exports it as the
 * JWK's `x`.
 */
export async function seededPair(name, seed) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new TypeError(`[${name}] a seed is 32 bytes`)
  const pkcs8 = Uint8Array.from([...PKCS8[name].match(/../g).map(b => parseInt(b, 16)), ...seed])
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name }, true, USAGES[name])
  let bin = ''
  for (const b of pkcs8) bin += String.fromCharCode(b)
  return { publicKey: (await crypto.subtle.exportKey('jwk', key)).x, privateKey: btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
}
