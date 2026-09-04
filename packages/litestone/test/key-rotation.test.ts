// test/key-rotation.test.ts
//
// Which key a stored value is under, and what happens when a caller sends
// something that merely looks like one (FJS-714, FJS-715, FJS-716).
//
// The envelope encoded the FORMAT version — the one thing about a stored value
// that never changes — and left out the one that does. Three failures came out
// of that single omission, and they are separated here because they have
// separate remedies:
//
//   FJS-714  `$rotateKey` runs one transaction per DATABASE, so a crash between
//            two commits leaves a schema in two keys under one global key
//            setting. Nothing could say which value was under which, no
//            old-key decrypt window existed, and the rotation could not be
//            resumed because there was no way to find the rows still to do.
//
//   FJS-715  The write path asked `isCiphertext`, which read three characters.
//            A caller-supplied `v1.`-prefixed string was stored VERBATIM in a
//            column the app promises is encrypted. The same one function gated
//            the HASH path, so a `v1.` value skipped hashing too.
//
//   FJS-716  A decrypt that failed set the column to `null`, which is a WRONG
//            answer rather than a missing one: the row reads as empty and every
//            check on it passes.
//
// The envelope is asserted by PARSING it rather than by a prefix substring —
// the prefix has now moved once, and seven tests in this package read as green
// against a format that no longer existed.

import { describe, test, expect } from 'bun:test'
import { createClient } from '../src/index.js'
import { parseEnvelope, keyId, encryptField, decryptField, makeKeyring, verifiesAs, hashField }
  from '../src/core/encryption.js'

const K1 = 'a'.repeat(64)
const K2 = 'b'.repeat(64)
const K3 = 'c'.repeat(64)
const buf = (hex: string) => Buffer.from(hex, 'hex')

const SCHEMA = `
model User { id Int @id  @@auth }
model Secret {
  id    Int    @id @default(autoincrement())
  label String
  ssn   String  @encrypted
  email String? @encrypted(deterministic: true)
  pin   String? @hashed
}`

const open = (opts: Record<string, unknown> = {}) =>
  createClient({ schema: SCHEMA, db: ':memory:', encryptionKey: K1, ...opts })

// ─── the envelope names its key ──────────────────────────────────────────────

describe('a stored value says which key it is under', () => {
  test('all three modes carry the key id, and the id is not the key', () => {
    const k = buf(K1)
    const kid = keyId(k)
    expect(kid).toMatch(/^[0-9a-f]{8}$/)
    // A fingerprint, not key material: a different key gives a different id and
    // neither id contains any of either key.
    expect(keyId(buf(K2))).not.toBe(kid)
    expect(K1).not.toContain(kid)

    for (const [mode, made] of [
      ['enc',  encryptField('x', k)],
      ['hash', hashField('x', k)],
    ] as const) expect(parseEnvelope(made)).toMatchObject({ version: 2, mode, kid })
  })

  test('a value that is not an envelope parses as none', () => {
    for (const v of ['hello', 'v1', 'v2.short', 'v2.', '', 'v3.abcdef12.x'])
      expect(parseEnvelope(v)).toBeNull()
    // …and a v1 value still parses, because a database written before this
    // change is full of them and they have to stay readable.
    expect(parseEnvelope('v1.abc')).toMatchObject({ version: 1, mode: 'enc', kid: null })
  })
})

describe('a keyring reads what the current key alone cannot', () => {
  test('a value under a rotated-away key is readable, and unreadable without it', () => {
    const c = encryptField('secret', buf(K1))
    expect(decryptField(c, makeKeyring(buf(K2), [buf(K1)]))).toBe('secret')
    // The negative control: the same value, the same client, one key short.
    expect(() => decryptField(c, buf(K2))).toThrow(/Cannot decrypt/)
  })

  test('the refusal names the key wanted and the keys held, and neither is a key', () => {
    const c = encryptField('secret', buf(K1))
    const err = (() => { try { decryptField(c, buf(K2)) } catch (e) { return e as Error } })()!
    expect(err.name).toBe('DecryptionFailedError')
    expect(err.message).toContain(keyId(buf(K1)))
    expect(err.message).toContain(keyId(buf(K2)))
    expect(err.message).toContain('previousEncryptionKeys')
    expect(err.message).not.toContain(K1)
    expect(err.message).not.toContain(K2)
  })

  test('an UNKNOWN kid still tries the ring — the tag is the authority, not the name', () => {
    // A kid is eight characters of a fingerprint and is used for ORDER, never as
    // a verdict. A value whose kid this ring has never seen is still opened if
    // some held key opens it, because GCM's tag is what cannot be forged.
    const c = encryptField('secret', buf(K1)).replace(keyId(buf(K1)), 'deadbeef')
    expect(decryptField(c, makeKeyring(buf(K2), [buf(K1)]))).toBe('secret')
  })
})

// ─── FJS-715: looking like ciphertext is not being ciphertext ────────────────

describe('a caller cannot store its own ciphertext', () => {
  test('a forged envelope is refused by name, and the same value without the prefix is not', async () => {
    const db = await open()
    const caller = db.$setAuth({ id: 1 })
    await expect(caller.secret.create({ data: { label: 'a', ssn: 'v1.forged' } }))
      .rejects.toThrow(/looks like a stored ciphertext/)
    // The pair: one character different and it is an ordinary value. Asserted
    // through the system client, because `@encrypted` strips the column from a
    // non-system reader — so the caller's own create result never carries it.
    await caller.secret.create({ data: { label: 'b', ssn: 'w1.forged' } })
    const stored = (await db.asSystem().secret.findFirst({ where: { label: 'b' } })) as { ssn: string }
    expect(stored.ssn).toBe('w1.forged')
    db.$close()
  })

  test('a REAL envelope is refused from a caller too', async () => {
    // A caller never legitimately holds one: a non-system read strips or
    // decrypts, so the value coming back to them is never the stored bytes.
    const db = await open()
    await db.asSystem().secret.create({ data: { label: 'a', ssn: 'x' } })
    const raw = (await db.asSystem().sql`SELECT ssn FROM secret LIMIT 1`) as { ssn: string }[]
    await expect(db.$setAuth({ id: 1 }).secret.create({ data: { label: 'b', ssn: raw[0].ssn } }))
      .rejects.toThrow(/looks like a stored ciphertext/)
    db.$close()
  })

  test('a system re-save of a real ciphertext is NOT double-encrypted', async () => {
    const db = await open()
    const sys = db.asSystem()
    await sys.secret.create({ data: { label: 'a', ssn: 'x' } })
    const before = ((await sys.sql`SELECT ssn FROM secret WHERE label='a'`) as { ssn: string }[])[0].ssn
    await sys.secret.create({ data: { label: 'b', ssn: before } })
    const after = ((await sys.sql`SELECT ssn FROM secret WHERE label='b'`) as { ssn: string }[])[0].ssn
    expect(after).toBe(before)
    expect(((await sys.secret.findFirst({ where: { label: 'b' } })) as { ssn: string }).ssn).toBe('x')
    db.$close()
  })

  // The half that made the old check wrong in a second way: ONE `isCiphertext`
  // checked all three prefixes and gated both the encrypt path and the hash
  // path, so an encryption-shaped value skipped HASHING and the column ended up
  // holding something that is not a digest of anything.
  test('an encryption envelope in a @hashed column is hashed, not stored', async () => {
    const db = await open()
    const sys = db.asSystem()
    const enc = encryptField('x', buf(K1))
    await sys.secret.create({ data: { label: 'a', ssn: 'x', pin: enc } })
    const raw = ((await sys.sql`SELECT pin FROM secret WHERE label='a'`) as { pin: string }[])[0].pin
    expect(parseEnvelope(raw)).toMatchObject({ mode: 'hash' })
    // …and a real digest in the same column IS left alone, or the row above
    // would pass against a guard that simply hashed everything twice.
    const digest = hashField('p', buf(K1))
    await sys.secret.create({ data: { label: 'b', ssn: 'x', pin: digest } })
    expect(((await sys.sql`SELECT pin FROM secret WHERE label='b'`) as { pin: string }[])[0].pin).toBe(digest)
    db.$close()
  })

  test('verifiesAs asks the tag, not the prefix', () => {
    const k = buf(K1)
    expect(verifiesAs(encryptField('x', k), k, 'enc')).toBe(true)
    expect(verifiesAs('v1.this-is-not-encrypted', k, 'enc')).toBe(false)
    // A real ciphertext under a key not on the ring does not verify either —
    // which is what keeps a system re-save from storing something it cannot read.
    expect(verifiesAs(encryptField('x', buf(K2)), k, 'enc')).toBe(false)
  })
})

// ─── FJS-716: a value that cannot be read is not an empty value ─────────────

describe('a decrypt that fails is raised, not blanked', () => {
  test('the wrong key throws naming the model and field, where it used to answer null', async () => {
    const a = await createClient({ schema: SCHEMA, db: '/tmp/ls-rot-test.db', encryptionKey: K1 })
    await a.asSystem().sql`DELETE FROM secret`
    await a.asSystem().secret.create({ data: { label: 'a', ssn: 'private' } })
    a.$close()

    const b = await createClient({ schema: SCHEMA, db: '/tmp/ls-rot-test.db', encryptionKey: K2 })
    const err = await b.asSystem().secret.findFirst({ where: { label: 'a' } })
      .then(() => null, (e: Error) => e)
    expect(err?.name).toBe('DecryptionFailedError')
    expect(err?.message).toContain('Secret.ssn')
    b.$close()

    // The pair, and the remedy the message names.
    const c = await createClient({
      schema: SCHEMA, db: '/tmp/ls-rot-test.db', encryptionKey: K2, previousEncryptionKeys: [K1] })
    expect(((await c.asSystem().secret.findFirst({ where: { label: 'a' } })) as { ssn: string }).ssn)
      .toBe('private')
    c.$close()
  })

  test('a previous key that is not 32 bytes is refused at createClient', async () => {
    await expect(open({ previousEncryptionKeys: ['zz'] })).rejects.toThrow(/must be 32 bytes/)
    // …and previous keys with no current key is a statement that cannot be true.
    await expect(createClient({ schema: SCHEMA, db: ':memory:', previousEncryptionKeys: [K1] }))
      .rejects.toThrow(/nothing to rotate to/)
  })
})

// ─── a database written before the envelope carried a key id ────────────────
//
// The one class no other test here can see: every suite in this package builds
// a FRESH database, so all of them agree with an envelope change that would
// break every existing app on its first query (`FJS-251`'s shape). The payload
// is byte-identical across versions — same key, same derivation, same digest —
// so the difference is the prefix alone, and equality compares the whole string.

describe('an existing database, written before the key id', () => {
  const LEGACY = `
model User { id Int @id  @@auth }
model S {
  id Int    @id @default(autoincrement())
  d  String @encrypted(deterministic: true)
  h  String @hashed
  r  String @encrypted
}`

  test('v1 values still read, and still match an equality filter', async () => {
    const db = await createClient({ schema: LEGACY, db: '/tmp/ls-legacy-env.db', encryptionKey: K1 })
    const sys = db.asSystem()
    await sys.sql`DELETE FROM s`
    await sys.s.create({ data: { d: 'legacy', h: 'tok', r: 'random' } })
    // Rewrite the three columns into the shape this database would hold if it
    // had been written before the change: the same payload under the v1 prefix.
    await sys.sql`UPDATE s SET
      d = 'v1d.' || substr(d, 14),
      h = 'v1h.' || substr(h, 14),
      r = 'v1.'  || substr(r, 13)`

    const raw = ((await sys.sql`SELECT d, h, r FROM s`) as Record<string, string>[])[0]
    expect(parseEnvelope(raw.d)).toMatchObject({ version: 1, mode: 'det' })
    expect(parseEnvelope(raw.h)).toMatchObject({ version: 1, mode: 'hash' })
    expect(parseEnvelope(raw.r)).toMatchObject({ version: 1, mode: 'enc' })

    const row = (await sys.s.findFirst({})) as { d: string, r: string }
    expect(row.d).toBe('legacy')
    expect(row.r).toBe('random')
    // The half that would have failed silently: the operand is encoded in the
    // CURRENT envelope and the stored value is in the old one.
    expect(((await sys.s.findMany({ where: { d: 'legacy' } })) as unknown[]).length).toBe(1)
    expect(((await sys.s.findMany({ where: { h: 'tok' } })) as unknown[]).length).toBe(1)
    // …and the negative control, or a filter that matched everything would pass.
    expect(((await sys.s.findMany({ where: { d: 'other' } })) as unknown[]).length).toBe(0)
    db.$close()
  })

  test('a v1 value is re-saved by the system without being double-encrypted', async () => {
    const db = await createClient({ schema: LEGACY, db: ':memory:', encryptionKey: K1 })
    const sys = db.asSystem()
    const legacy = 'v1.' + encryptField('old', buf(K1)).split('.').slice(2).join('.')
    await sys.s.create({ data: { d: 'x', h: 'y', r: legacy } })
    expect(((await sys.sql`SELECT r FROM s`) as { r: string }[])[0].r).toBe(legacy)
    expect(((await sys.s.findFirst({})) as { r: string }).r).toBe('old')
    db.$close()
  })
})

// ─── FJS-714: a rotation that can be resumed ─────────────────────────────────

describe('$rotateKey', () => {
  test('every value moves to the new kid and stays readable', async () => {
    const db = await open()
    const sys = db.asSystem()
    for (const label of ['a', 'b', 'c'])
      await sys.secret.create({ data: { label, ssn: `s-${label}`, email: `${label}@x` } })

    const kids = async () => new Set(((await sys.sql`SELECT ssn FROM secret`) as { ssn: string }[])
      .map(r => parseEnvelope(r.ssn)!.kid))
    expect(await kids()).toEqual(new Set([keyId(buf(K1))]))

    await db.$rotateKey(K2, { orphan: ['Secret.pin'] })
    expect(await kids()).toEqual(new Set([keyId(buf(K2))]))
    expect(((await sys.secret.findMany({ orderBy: { id: 'asc' } })) as { ssn: string }[]).map(r => r.ssn))
      .toEqual(['s-a', 's-b', 's-c'])
    db.$close()
  })

  test('the OLD key stays on the ring, which is what makes a partial rotation survivable', async () => {
    // The rotation loop is one transaction per DATABASE, so a crash between two
    // commits leaves a schema in two keys. Dropping the old key at the end
    // would make exactly that state unreadable — asserted by rotating twice and
    // reading a value written under the first key each time.
    const db = await open()
    const sys = db.asSystem()
    await sys.secret.create({ data: { label: 'a', ssn: 'kept' } })
    await db.$rotateKey(K2, { orphan: ['Secret.pin'] })
    await db.$rotateKey(K3, { orphan: ['Secret.pin'] })
    expect(((await sys.secret.findFirst({ where: { label: 'a' } })) as { ssn: string }).ssn).toBe('kept')
    db.$close()
  })

  test('running it again finishes it rather than destroying it', async () => {
    // What makes a crashed rotation resumable: a row already on the new kid
    // decrypts, re-encrypts to the same kid, and costs a write rather than a
    // wrong answer.
    const db = await open()
    const sys = db.asSystem()
    await sys.secret.create({ data: { label: 'a', ssn: 'twice' } })
    await db.$rotateKey(K2, { orphan: ['Secret.pin'] })
    await db.$rotateKey(K2, { orphan: ['Secret.pin'] })
    expect(((await sys.secret.findFirst({ where: { label: 'a' } })) as { ssn: string }).ssn).toBe('twice')
    db.$close()
  })

  // The failure `previousEncryptionKeys` would otherwise have CREATED by making
  // a half-rotated schema supported: deterministic encoding is a function of
  // the key, so an operand encoded under the current one does not equal the
  // same value stored under a previous one — and nothing would have said so.
  test('a deterministic filter finds a row written under a previous key', async () => {
    const a = await createClient({ schema: SCHEMA, db: '/tmp/ls-rot-det.db', encryptionKey: K1 })
    await a.asSystem().sql`DELETE FROM secret`
    await a.asSystem().secret.create({ data: { label: 'a', ssn: 'x', email: 'findme@x' } })
    a.$close()

    const b = await createClient({
      schema: SCHEMA, db: '/tmp/ls-rot-det.db', encryptionKey: K2, previousEncryptionKeys: [K1] })
    const sys = b.asSystem()
    expect(((await sys.secret.findMany({ where: { email: 'findme@x' } })) as unknown[]).length).toBe(1)
    // Every spelling of equality, because each is rewritten on its own line.
    expect(((await sys.secret.findMany({ where: { email: { equals: 'findme@x' } } })) as unknown[]).length).toBe(1)
    expect(((await sys.secret.findMany({ where: { email: { in: ['findme@x'] } } })) as unknown[]).length).toBe(1)
    expect(((await sys.secret.findMany({ where: { email: { not: 'findme@x' } } })) as unknown[]).length).toBe(0)
    expect(((await sys.secret.findMany({ where: { email: 'other@x' } })) as unknown[]).length).toBe(0)
    b.$close()
  })
})
