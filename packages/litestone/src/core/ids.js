// core/ids.js — the generators behind `@default(uuid()|ulid()|cuid()|nanoid())`
//
// One owner, because two boundaries fill these in and they must agree: the
// SQLite client at insert time (core/client.js) and the jsonl driver when it
// builds a record (drivers/jsonl.js). Neither may import the other.
//
// uuid()   — crypto.randomUUID(), RFC 4122 v4. The one kind ddl.js can express
//            as a SQL DEFAULT, so SQLite fills it where nothing else did.
// ulid()   — 26-char base32, millisecond timestamp prefix, sortable.
// cuid()   — cuid2-style: 'c' + 24 random base36 chars.
// nanoid() — URL-safe, 21 chars by default.
//
// No dependencies: a schema-seeded default that needs an npm package is a
// default an app cannot rely on.

import { randomBytes } from 'node:crypto'

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
// ddl.js gives it a SQL DEFAULT, and the other three emit none, so a required
// column declaring one could not be inserted at all (FJS-423).

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

// ─── who assigns the key ──────────────────────────────────────────────────────

/**
 * Does the SERVER fill this `@id`, or must the caller supply it?
 *
 * Two readers ask, and for as long as they each answered it themselves they
 * disagreed (`FJS-608`). `jsonschema.js` excluded every `@id` from create mode
 * as *server-assigned*, so a key the caller must supply was not merely
 * un-required but ABSENT — and with `additionalProperties: false` beside it,
 * junction's `autoValidate` then refused a create that carried the key it could
 * not have known to ask for, and a generated form offered no box to type it in.
 * `client.js`'s required pre-flight answered a narrower version of the same
 * question and got the composite case wrong in the other direction.
 *
 * Three shapes and only the first two are the server's:
 *
 *   `@default(…)`      — filled here for uuid()/ulid()/cuid()/nanoid(), and by
 *                        SQLite for autoincrement() or a literal.
 *   a lone `Int @id`   — SQLite's rowid alias, which auto-assigns with no
 *                        default declared.
 *   anything else      — a slug, a stock keeping unit, an external system's
 *                        identifier, or any member of a composite key. Nobody
 *                        but the caller can produce it.
 *
 * **A composite key is never a rowid alias.** `PRIMARY KEY (a, b)` is an
 * ordinary index whatever the column types, so an `Int` member of one is a
 * column the caller must supply — where a lone `Int @id` is not. The pre-flight
 * tested the type and not the key, so a missing member reached SQLite and came
 * back as a raw `NOT NULL constraint failed` naming a physical table, which is
 * the error shape every other required field exists to avoid.
 */
export function isServerAssignedId(field, model) {
  if (!field.attributes?.some(a => a.kind === 'id')) return false
  if (field.attributes.some(a => a.kind === 'default')) return true
  if (field.type?.name !== 'Int') return false
  const keyWidth = (model?.fields ?? []).filter(f => f.attributes?.some(a => a.kind === 'id')).length
  return keyWidth === 1
}
