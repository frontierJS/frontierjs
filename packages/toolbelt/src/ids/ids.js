// ids.js — the generators behind `@default(uuid()|ulid()|cuid()|nanoid())`
//
// A kit rather than a litestone module because BOTH ENDS mint now. The SQLite
// client fills an omitted `@id` at insert time and the jsonl driver does the
// same when it builds a record; offline, a browser has to state the id itself,
// because a row created with no server reachable has children that must name it
// before anything has been inserted anywhere. Three fillers, one answer, or a
// record written on a phone changes shape when it reaches the server.
//
// uuid()   — crypto.randomUUID(), RFC 4122 v4. The one kind litestone's DDL can
//            express as a SQL DEFAULT, so SQLite fills it where nothing else did.
// ulid()   — 26-char base32, millisecond timestamp prefix, sortable.
// cuid()   — cuid2-style: 'c' + 24 random base36 chars.
// nanoid() — URL-safe, 21 chars by default.
//
// **Randomness is WebCrypto and may not be `node:crypto`.** These ran on a
// server and `randomBytes` was the obvious import; a browser has no such module
// and the import fails at PARSE, so a bundle that merely mentions this file is
// dead before a line of it runs. `crypto.getRandomValues` is the one spelling
// both runtimes have.

const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n))

// ── ULID (spec-compliant) ─────────────────────────────────────────────────────
const ULID_CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function generateUlid() {
  const now   = Date.now()
  let ts = ''
  let t  = now
  for (let i = 9; i >= 0; i--) { ts = ULID_CHARS[t % 32] + ts; t = Math.floor(t / 32) }
  let rand = ''
  const bytes = randomBytes(10)
  // Encode 80 bits of randomness into 16 base32 chars
  let acc = 0, bits = 0
  for (const byte of bytes) {
    acc  = (acc << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      rand += ULID_CHARS[(acc >> bits) & 31]
    }
  }
  return ts + rand
}

// ── cuid2-style ───────────────────────────────────────────────────────────────
const CUID_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz'
const CUID_LEN   = 24

export function generateCuid() {
  let id = 'c'
  while (id.length <= CUID_LEN) {
    for (const byte of randomBytes(CUID_LEN * 2)) {
      // 252 = 36 × 7. Taking the tail modulo 36 would make the first four
      // letters likelier than the rest, which is entropy the length implies
      // and the value would not have.
      if (byte >= 252) continue
      id += CUID_CHARS[byte % 36]
      if (id.length > CUID_LEN) break
    }
  }
  return id
}

// ── nanoid ────────────────────────────────────────────────────────────────────
const NANOID_ALPHABET = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict'

export function generateNanoid(size = 21, alphabet = NANOID_ALPHABET) {
  const bytes = randomBytes(size)
  let id = ''
  for (let i = 0; i < size; i++) {
    id += alphabet[bytes[i] & (alphabet.length - 1 > 255 ? 255 : alphabet.length - 1)]
  }
  return id
}

// ── The two tables ────────────────────────────────────────────────────────────
// ID_GENERATORS is what an @id field may declare. GENERATED_DEFAULTS is the
// subset a NON-id column needs filled in code: `uuid()` is absent because
// litestone's DDL gives it a SQL DEFAULT, and the other three emit none, so a
// required column declaring one could not be inserted at all (FJS-423).

export const ID_GENERATORS = {
  uuid:   () => crypto.randomUUID(),
  ulid:   generateUlid,
  cuid:   generateCuid,
  nanoid: generateNanoid,
}

export const GENERATED_DEFAULTS = {
  ulid:   generateUlid,
  cuid:   generateCuid,
  nanoid: generateNanoid,
}

/**
 * Mint one id of the named kind, or `null` for a kind this table has no
 * generator for.
 *
 * Null rather than a throw because the caller is usually a client deciding
 * whether it CAN state an id, and a kind it cannot mint is an answer rather
 * than a fault — the write goes to the server to be keyed there instead.
 */
export function mintId(kind) {
  const gen = ID_GENERATORS[kind]
  return gen ? gen() : null
}
