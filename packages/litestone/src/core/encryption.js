// encryption.js — how a value becomes the bytes a column holds, and back
//
// One owner for that translation, because two callers need it and they are in
// packages that cannot import each other: client.js encodes a `where` operand
// before comparing (`rewriteEncryptedWhere`), and policy.js encodes a `@@allow`
// operand for exactly the same reason. Policy predicates were compiled without
// this step, so a policy naming an encrypted column compared plaintext against
// stored bytes and denied every row to everyone (FJS-214).

import { createCipheriv, createDecipheriv, randomBytes, createHmac } from 'crypto'

// ─── Encryption ───────────────────────────────────────────────────────────────
// Three modes, along one axis — can the value be read back?
//
//   @encrypted                      v1.   AES-256-GCM, RANDOM iv    recoverable, not filterable
//   @encrypted(deterministic: true) v1d.  AES-256-GCM, DERIVED iv   recoverable, equality-filterable
//   @hashed                         v1h.  HMAC-SHA256               NOT recoverable, equality-filterable
//
// There is no fourth cell: a value that can be neither read nor matched is a value
// that was deleted.
//
// `v1s.` was a fourth prefix that stored an HMAC under the @encrypted name and is
// gone. Nothing reads it: a column holding one is unrecoverable, so recognising the
// prefix could only produce a friendlier way to say the same loss. See CHANGES.md.
//
// Payload (base64url) is `iv + tag + ciphertext` for both AES modes, so one
// decrypt path serves them; @hashed has no decrypt path at all.

const ENC_PREFIX      = 'v1.'
const ENC_D_PREFIX    = 'v1d.'
const HASH_PREFIX     = 'v1h.'
const GCM_IV_LEN      = 12
const GCM_TAG_LEN     = 16
const HMAC_ALG        = 'sha256'

// Domain separation. The IV and the digest are both HMACs of the same plaintext
// under the same root key, so without distinct salts a deterministic field's IV
// and a @hashed field's stored digest would be the same 12/32 bytes of the same
// function — and the IV travels in the clear inside the payload, which would hand
// out a prefix of the digest for free.
const IV_SALT         = Buffer.from('litestone/iv/v1')
const HASH_SALT       = Buffer.from('litestone/hash/v1')

export function encryptField(plaintext, key) {
  if (plaintext == null) return plaintext
  const iv         = randomBytes(GCM_IV_LEN)
  const cipher     = createCipheriv('aes-256-gcm', key, iv)
  const encrypted  = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  const tag        = cipher.getAuthTag()
  const payload    = Buffer.concat([iv, tag, encrypted])
  return ENC_PREFIX + payload.toString('base64url')
}

export function decryptField(ciphertext, key) {
  if (ciphertext == null) return ciphertext
  const s      = String(ciphertext)
  const prefix = s.startsWith(ENC_D_PREFIX) ? ENC_D_PREFIX
               : s.startsWith(ENC_PREFIX)   ? ENC_PREFIX
               : null
  if (!prefix) return ciphertext  // not encrypted
  const payload    = Buffer.from(s.slice(prefix.length), 'base64url')
  const iv         = payload.subarray(0, GCM_IV_LEN)
  const tag        = payload.subarray(GCM_IV_LEN, GCM_IV_LEN + GCM_TAG_LEN)
  const encrypted  = payload.subarray(GCM_IV_LEN + GCM_TAG_LEN)
  const decipher   = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return decipher.update(encrypted) + decipher.final('utf8')
}

// The IV is a FUNCTION of the plaintext, which is the entire mechanism: the same
// value encrypts to the same bytes, so `WHERE col = ?` works after encrypting the
// operand the same way.
//
// GCM breaks catastrophically on nonce reuse across DIFFERENT plaintexts — the
// keystream repeats and XORing two ciphertexts reveals both. Deriving the nonce
// from the plaintext makes that a SHA-256 collision rather than an accident, and
// reuse across IDENTICAL plaintexts is not a weakness, it is the property being
// bought. Same construction Rails ships for `deterministic: true`.
//
// The trade this makes, and it is not hidden: equal values are visibly equal in the
// column to anyone holding the database. That is true of every searchable-encryption
// scheme — a blind index leaks exactly the same fact — and it is why this is opt-in
// per field rather than the default.
function deriveIv(plaintext, key) {
  return createHmac(HMAC_ALG, Buffer.concat([Buffer.from(key), IV_SALT]))
    .update(String(plaintext)).digest().subarray(0, GCM_IV_LEN)
}

export function encryptDeterministic(plaintext, key) {
  if (plaintext == null) return plaintext
  const iv         = deriveIv(plaintext, key)
  const cipher     = createCipheriv('aes-256-gcm', key, iv)
  const encrypted  = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  const tag        = cipher.getAuthTag()
  const payload    = Buffer.concat([iv, tag, encrypted])
  return ENC_D_PREFIX + payload.toString('base64url')
}

// @hashed. One way, by construction and by name — there is no inverse of an HMAC,
// so nothing here has a partner function elsewhere in this file.
export function hashField(plaintext, key) {
  if (plaintext == null) return plaintext
  const hmac = createHmac(HMAC_ALG, Buffer.concat([Buffer.from(key), HASH_SALT]))
    .update(String(plaintext)).digest('base64url')
  return HASH_PREFIX + hmac
}

export function isCiphertext(value) {
  const s = String(value ?? '')
  return s.startsWith(ENC_PREFIX) || s.startsWith(ENC_D_PREFIX) || s.startsWith(HASH_PREFIX)
}

// Normalise key: hex string, Buffer, or Uint8Array → 32-byte Buffer
export function normaliseKey(raw) {
  if (!raw || (typeof raw === 'string' && !raw.trim())) return null
  if (typeof raw === 'string') return Buffer.from(raw, 'hex')
  return Buffer.from(raw)
}

// ─── Comparing a value to an encoded column ───────────────────────────────────
// The single answer to "can this column be compared, and with what". Every
// caller asks here rather than re-deciding from a field policy of its own: a
// `where` and a `@@allow` predicate over the same column must compile the same
// comparison, and they did not.
//
// `encode: null` with a label is a column that holds bytes nothing can be
// compared against — plain @encrypted stores a random IV, so no encoding of the
// operand reproduces the stored value. That is a refusal, not an absence, which
// is why it is not the same answer as `null`.
export function comparisonEncoderFor(policy) {
  if (!policy) return null
  if (policy.hashed) return {
    encode: hashField,
    label:  '@hashed, which stores a one-way digest',
  }
  if (policy.encrypted?.deterministic) return {
    encode: encryptDeterministic,
    label:  '@encrypted(deterministic: true), which stores ciphertext under an IV derived from the value',
  }
  if (policy.encrypted) return {
    encode: null,
    label:  '@encrypted, which stores ciphertext under a random IV',
  }
  return null
}
