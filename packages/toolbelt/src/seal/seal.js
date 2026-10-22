/*
 * seal.js — a value only one key can open.
 *
 * Pony Express keeps a letter in a Durable Object on somebody's Cloudflare
 * account until it is read (`IDEAS/pony-express.md` Phase 3). A letter sealed
 * to the recipient's public key is ciphertext to that host, and to anyone who
 * reads its storage, and opens only with the private key on the recipient's
 * machine. There is no session and no reply: the sender and the recipient need
 * never be online together.
 *
 * The construction is HPKE's base mode, RFC 9180, single-shot:
 * DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM (suite 0x0020 /
 * 0x0001 / 0x0002), `info` = `frontierjs/seal v1`, empty AAD. An ephemeral
 * X25519 key per seal, its shared secret with the recipient's key run through
 * HKDF over both public keys, and the result keys one AEAD. Any HPKE library
 * opens what this seals under that suite and `info`, which is how it was
 * checked; a change to a label or a length here breaks that silently.
 *
 * WebCrypto and nothing else, so a terminal and a browser seal with one
 * function and the kit keeps its zero dependencies. Converting the Ed25519
 * signing key to X25519, as age does, is not here on purpose: WebCrypto has no
 * conversion, and a browser member's key lives in IndexedDB where one cannot
 * reach it, so a member holds a second pair (`FJS-D1400`).
 *
 * Pure but for `generateSealingKeys` and `seal` itself, which draw an
 * ephemeral key the way `/ids` draws randomness. Neither reads a clock.
 *
 * The version rides in the sealed value (`v1.`), for `/signature`'s reason: a
 * value from a scheme this side no longer speaks would otherwise fail exactly
 * as a tampered one does.
 */

import { seededPair } from '../signature/seeded.js'

const ENCODER = new TextEncoder()
const X25519  = { name: 'X25519' }
const VERSION = 'v1.'

// RFC 9180 binds every derivation to the suite, so a key derived for one suite
// is never a key in another, and to the application through `info`.
const KEM_ID  = bytes('KEM', 0x00, 0x20)
const SUITE   = bytes('HPKE', 0x00, 0x20, 0x00, 0x01, 0x00, 0x02)
const INFO    = ENCODER.encode('frontierjs/seal v1')
const ENC_LEN = 32

function bytes(text, ...tail) {
  return concat(ENCODER.encode(text), Uint8Array.from(tail))
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

/*
 * Keys travel as base64url strings, the raw 32-byte public key and the PKCS#8
 * private key, exactly as `/signature`'s do: a key is written to `key.json` and
 * sent in a JSON body, and a CryptoKey can be neither.
 */
function toBase64url(data) {
  let bin = ''
  for (const b of new Uint8Array(data)) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64url(text) {
  const s = String(text).replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(s + '='.repeat((4 - s.length % 4) % 4))
  return Uint8Array.from(bin, c => c.charCodeAt(0))
}

async function hmac(key, data) {
  // A zero-length HMAC key is refused by WebCrypto, and RFC 5869 reads an
  // absent salt as HashLen zero bytes, which HMAC pads to the same key.
  const raw = key.length ? key : new Uint8Array(32)
  const k = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data))
}

// HKDF in its two halves, because RFC 9180 labels each one separately and
// WebCrypto's HKDF only offers them fused.
function labeledExtract(suite, salt, label, ikm) {
  return hmac(salt, concat(ENCODER.encode('HPKE-v1'), suite, ENCODER.encode(label), ikm))
}

async function labeledExpand(suite, prk, label, info, length) {
  const labeled = concat(Uint8Array.of(length >> 8, length & 0xff), ENCODER.encode('HPKE-v1'), suite, ENCODER.encode(label), info)
  let block = new Uint8Array(0)
  let out = new Uint8Array(0)
  for (let i = 1; out.length < length; i++) {
    block = await hmac(prk, concat(block, labeled, Uint8Array.of(i)))
    out = concat(out, block)
  }
  return out.slice(0, length)
}

// DHKEM's shared secret. `kem_context` is both public keys, so a secret is
// bound to the pair it was made between and a swapped key opens nothing.
async function sharedSecret(dh, enc, recipientPublic) {
  const kemContext = concat(enc, recipientPublic)
  const prk = await labeledExtract(KEM_ID, new Uint8Array(0), 'eae_prk', dh)
  return labeledExpand(KEM_ID, prk, 'shared_secret', kemContext, 32)
}

// The base-mode key schedule: no PSK, the kit's `info`, sequence number 0.
async function aeadKey(secret) {
  const empty = new Uint8Array(0)
  const context = concat(
    Uint8Array.of(0x00),
    await labeledExtract(SUITE, empty, 'psk_id_hash', empty),
    await labeledExtract(SUITE, empty, 'info_hash', INFO),
  )
  const prk = await labeledExtract(SUITE, secret, 'secret', empty)
  const key = await crypto.subtle.importKey('raw', await labeledExpand(SUITE, prk, 'key', context, 32), 'AES-GCM', false, ['encrypt', 'decrypt'])
  return { key, iv: await labeledExpand(SUITE, prk, 'base_nonce', context, 12) }
}

/**
 * A key pair for `seal` and `open`, both halves base64url. Kept beside the
 * Ed25519 signing pair, never derived from it (`FJS-D1400`). Given `seed`, 32
 * bytes, the pair is the seed's and nothing is drawn.
 *
 * @param {{ seed?: Uint8Array }} [opts]
 * @returns {Promise<{ publicKey: string, privateKey: string }>}
 */
export async function generateSealingKeys({ seed } = {}) {
  if (seed) return seededPair('X25519', seed)
  const pair = await crypto.subtle.generateKey(X25519, true, ['deriveBits'])
  return {
    publicKey:  toBase64url(await crypto.subtle.exportKey('raw', pair.publicKey)),
    privateKey: toBase64url(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
  }
}

/**
 * Seal `data` to the holder of `publicKey`. A string is sealed as its UTF-8.
 * The answer is a string, `v1.` and the base64url of the ephemeral public key
 * followed by the ciphertext, 48 characters longer than the data's base64url.
 * Sealing twice gives two different values.
 *
 * @param {string} publicKey  base64url, from `generateSealingKeys`
 * @param {Uint8Array | string} data
 * @returns {Promise<string>}
 */
export async function seal(publicKey, data) {
  const recipient = fromBase64url(publicKey)
  if (recipient.length !== 32) throw new Error('[seal] a sealing public key is 32 bytes of base64url.')
  const pkR = await crypto.subtle.importKey('raw', recipient, X25519, false, [])
  const ephemeral = await crypto.subtle.generateKey(X25519, true, ['deriveBits'])
  const enc = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey))
  const dh  = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: pkR }, ephemeral.privateKey, 256))

  const { key, iv } = await aeadKey(await sharedSecret(dh, enc, recipient))
  const plain = typeof data === 'string' ? ENCODER.encode(data) : data
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain))
  return VERSION + toBase64url(concat(enc, sealed))
}

/**
 * Open what `seal` sealed to this key: the original bytes, or null for
 * anything that does not open — tampered, sealed to another key, truncated or
 * from another version. Null and never a throw, because a sealed value is
 * remote input and the reader must not be crashed by it. A `privateKey` that
 * does not parse is the caller's own and throws.
 *
 * @param {string} privateKey  base64url PKCS#8, from `generateSealingKeys`
 * @param {string} sealed
 * @returns {Promise<Uint8Array | null>}
 */
export async function open(privateKey, sealed) {
  let skR
  try {
    skR = await crypto.subtle.importKey('pkcs8', fromBase64url(privateKey), X25519, true, ['deriveBits'])
  } catch {
    throw new Error('[seal] the private key is not a base64url PKCS#8 X25519 key.')
  }
  try {
    const text = String(sealed ?? '')
    if (!text.startsWith(VERSION)) return null
    const body = fromBase64url(text.slice(VERSION.length))
    if (body.length < ENC_LEN + 16) return null
    const enc = body.subarray(0, ENC_LEN)
    const pkE = await crypto.subtle.importKey('raw', enc, X25519, false, [])
    const dh  = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: pkE }, skR, 256))
    const recipient = fromBase64url((await crypto.subtle.exportKey('jwk', skR)).x)

    const { key, iv } = await aeadKey(await sharedSecret(dh, enc, recipient))
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, body.subarray(ENC_LEN)))
  } catch {
    return null
  }
}
