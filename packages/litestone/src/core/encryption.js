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
// gone. Nothing reads it: a column holding one is unrecoverable, so recognizing the
// prefix could only produce a friendlier way to say the same loss. See CHANGES.md.
//
// Payload (base64url) is `iv + tag + ciphertext` for both AES modes, so one
// decrypt path serves them; @hashed has no decrypt path at all.

// ─── The envelope names the KEY, not just the format ─────────────────────────
//
// `v1.` encoded the FORMAT version, which is the one thing about a stored value
// that never changes, and left out the one that does: which key it is under.
// The cost was not theoretical. `$rotateKey` runs one transaction per DATABASE,
// so a crash between two commits leaves database A on the new key and B on the
// old with a single global key setting — and nothing could say which was which,
// no old-key decrypt window existed, and a rotation could not be resumed
// because there was no way to find the rows still to do (`FJS-714`).
//
//   v1.<payload>            legacy, no key id — decrypted by trying every held key
//   v2.<kid>.<payload>      AES-256-GCM, random iv
//   v2d.<kid>.<payload>     AES-256-GCM, derived iv (deterministic)
//   v2h.<kid>.<payload>     HMAC-SHA256
//
// The `kid` is a domain-separated HMAC of the key, truncated — it identifies a
// key without being one, so it is safe in a column, in a log line and in an
// error message. Eight hex characters distinguishes the two or three keys a
// rotation ever holds at once; it is not a collision-resistant identifier and
// is not used as one, since an unknown kid falls back to trying what is held.
const ENC_PREFIX      = 'v1.'
const ENC_D_PREFIX    = 'v1d.'
const HASH_PREFIX     = 'v1h.'
const ENC_PREFIX_2    = 'v2.'
const ENC_D_PREFIX_2  = 'v2d.'
const HASH_PREFIX_2   = 'v2h.'
const GCM_IV_LEN      = 12
const GCM_TAG_LEN     = 16
const HMAC_ALG        = 'sha256'
const KID_SALT        = Buffer.from('litestone/kid/v1')
const KID_LEN         = 8

// Domain separation. The IV and the digest are both HMACs of the same plaintext
// under the same root key, so without distinct salts a deterministic field's IV
// and a @hashed field's stored digest would be the same 12/32 bytes of the same
// function — and the IV travels in the clear inside the payload, which would hand
// out a prefix of the digest for free.
const IV_SALT         = Buffer.from('litestone/iv/v1')
const HASH_SALT       = Buffer.from('litestone/hash/v1')

/** Which key this is, said in a way that is not the key. */
export function keyId(key) {
  return createHmac(HMAC_ALG, Buffer.concat([Buffer.from(key), KID_SALT]))
    .digest('hex').slice(0, KID_LEN)
}

// mode: 'enc' | 'det' | 'hash' — what was done to the value, which is a
// different question from which key did it. A caller matching a `@hashed`
// column against `enc` is the bug this separation exists for: one
// `isCiphertext` checking all three prefixes gated both the encrypt path and
// the hash path, so a `v1.`-prefixed string skipped HASHING (`FJS-715`).
const PREFIXES = [
  { p: ENC_D_PREFIX_2, mode: 'det',  kidded: true  },
  { p: ENC_PREFIX_2,   mode: 'enc',  kidded: true  },
  { p: HASH_PREFIX_2,  mode: 'hash', kidded: true  },
  { p: ENC_D_PREFIX,   mode: 'det',  kidded: false },
  { p: ENC_PREFIX,     mode: 'enc',  kidded: false },
  { p: HASH_PREFIX,    mode: 'hash', kidded: false },
]

/**
 * Read a stored value's envelope, or null where it has none.
 *
 * SHAPE ONLY — it says what the bytes claim, never that the claim is true. A
 * caller-supplied `v2.deadbeef.nonsense` parses here exactly as a real value
 * does, which is why the write path asks `verifies()` and the read path lets
 * GCM's tag answer.
 */
export function parseEnvelope(value) {
  if (value == null) return null
  const s = String(value)
  for (const { p, mode, kidded } of PREFIXES) {
    if (!s.startsWith(p)) continue
    if (!kidded) return { version: 1, mode, kid: null, payload: s.slice(p.length), prefix: p }
    const rest = s.slice(p.length)
    const dot  = rest.indexOf('.')
    // A v2 prefix with no `.` after it is not a v2 envelope. Falling through
    // rather than returning a kid-less v2 keeps the two versions decidable.
    if (dot !== KID_LEN) continue
    return { version: 2, mode, kid: rest.slice(0, dot), payload: rest.slice(dot + 1), prefix: p }
  }
  return null
}

export function encryptField(plaintext, key) {
  if (plaintext == null) return plaintext
  const iv         = randomBytes(GCM_IV_LEN)
  const cipher     = createCipheriv('aes-256-gcm', key, iv)
  const encrypted  = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  const tag        = cipher.getAuthTag()
  const payload    = Buffer.concat([iv, tag, encrypted])
  return ENC_PREFIX_2 + keyId(key) + '.' + payload.toString('base64url')
}

function openGcm(payloadB64, key) {
  const payload    = Buffer.from(payloadB64, 'base64url')
  const iv         = payload.subarray(0, GCM_IV_LEN)
  const tag        = payload.subarray(GCM_IV_LEN, GCM_IV_LEN + GCM_TAG_LEN)
  const encrypted  = payload.subarray(GCM_IV_LEN + GCM_TAG_LEN)
  const decipher   = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return decipher.update(encrypted) + decipher.final('utf8')
}

/**
 * `key` is a Buffer or a KEYRING — `{ current, byKid, all }` from `makeKeyring`.
 * A Buffer is the one-key case and is not a second path: it is wrapped here, so
 * every caller that already had one keeps working unchanged.
 *
 * A v2 envelope names its key. An unknown kid still TRIES the ring rather than
 * refusing on the name alone: a kid is eight characters of a fingerprint, and
 * the authoritative answer is GCM's tag, which a wrong key cannot forge. What
 * the kid buys is the ORDER — the right key first, and a resumable rotation,
 * which is a question about which rows are still on the old kid.
 */
export function decryptField(ciphertext, key) {
  if (ciphertext == null) return ciphertext
  const env = parseEnvelope(ciphertext)
  if (!env || env.mode === 'hash') return ciphertext   // not encrypted, or one-way

  const ring   = asKeyring(key)
  const named  = env.kid ? ring.byKid.get(env.kid) : null
  const order  = named ? [named, ...ring.all.filter(k => k !== named)] : ring.all

  let last = null
  for (const k of order) {
    try { return openGcm(env.payload, k) } catch (e) { last = e }
  }
  // Every held key was tried and GCM refused each — the value is authentic
  // under a key this process does not have, or it is not a value at all.
  const err = new Error(
    `Cannot decrypt: the value names key '${env.kid ?? '(v1, unnamed)'}' and this client holds ` +
    `${ring.all.length === 1 ? `'${keyId(ring.current)}'` : ring.all.map(k => `'${keyId(k)}'`).join(', ')}. ` +
    `A key that has been rotated away from is passed as previousEncryptionKeys: ['<hex>'].`)
  err.name  = 'DecryptionFailedError'
  err.kid   = env.kid
  err.cause = last
  throw err
}

/**
 * The same encoding as this database would have written before the envelope
 * carried a key id.
 *
 * The PAYLOAD is byte-identical across the two versions — same key, same
 * derivation, same digest — so a value stored as `v1d.<p>` and one encoded now
 * as `v2d.<kid>.<p>` differ in the prefix and in nothing else. Equality
 * filtering compares the whole stored string, so without this every
 * deterministic and every `@hashed` lookup against a row written before the
 * change would answer NOTHING, in every existing app, silently — and no test in
 * this repo could see it, because every one of them builds a fresh database
 * (`FJS-714`, `FJS-251`'s shape).
 */
export function legacyForm(encoded) {
  const env = parseEnvelope(encoded)
  if (!env || env.version !== 2) return null
  const v1 = env.mode === 'det' ? ENC_D_PREFIX : env.mode === 'hash' ? HASH_PREFIX : ENC_PREFIX
  return v1 + env.payload
}

/** One key, several keys, or a ring already built — one shape out. */
export function makeKeyring(current, previous = []) {
  const all = [current, ...previous].filter(Boolean).map(k => Buffer.from(k))
  const byKid = new Map()
  for (const k of all) if (!byKid.has(keyId(k))) byKid.set(keyId(k), k)
  return { current: all[0] ?? null, byKid, all }
}

function asKeyring(key) {
  if (key && key.byKid instanceof Map) return key
  return makeKeyring(key)
}

/**
 * Does this value actually decrypt, or merely look like it does?
 *
 * The write path's whole question. `isCiphertext` answered it by reading three
 * characters, so a caller sending `v1.` plus their own text had it stored
 * VERBATIM in a column the app promises is encrypted — and read back as `null`,
 * because the decrypt then failed (`FJS-715`). GCM's tag is the real answer and
 * a forgery cannot produce one.
 */
export function verifiesAs(value, key, mode) {
  const env = parseEnvelope(value)
  if (!env) return false
  if (mode === 'hash') return env.mode === 'hash'   // an HMAC has no inverse to check
  if (env.mode === 'hash') return false
  try { decryptField(value, key); return true } catch { return false }
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
  return ENC_D_PREFIX_2 + keyId(key) + '.' + payload.toString('base64url')
}

// @hashed. One way, by construction and by name — there is no inverse of an HMAC,
// so nothing here has a partner function elsewhere in this file.
export function hashField(plaintext, key) {
  if (plaintext == null) return plaintext
  const hmac = createHmac(HMAC_ALG, Buffer.concat([Buffer.from(key), HASH_SALT]))
    .update(String(plaintext)).digest('base64url')
  return HASH_PREFIX_2 + keyId(key) + '.' + hmac
}

export function isCiphertext(value) {
  const s = String(value ?? '')
  return s.startsWith(ENC_PREFIX) || s.startsWith(ENC_D_PREFIX) || s.startsWith(HASH_PREFIX)
}

// Normalize key: hex string, Buffer, or Uint8Array → 32-byte Buffer
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
