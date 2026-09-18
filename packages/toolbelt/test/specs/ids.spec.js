/*
 * ids.spec.js
 *
 * These generators moved out of litestone because a browser has to mint the
 * same id the server would — a row created offline is named before anything has
 * been inserted, or its children have nothing to reference. So what is asserted
 * here is SHAPE and INDEPENDENCE: the alphabet, the length, the sortable prefix,
 * and that no two calls collide, because a client-minted key that repeats is a
 * silent overwrite on the drain rather than an error anywhere.
 *
 * The move's own hazard is the import: `node:crypto` parses on a server and
 * kills a bundle, so the last test asserts the file names no node builtin.
 */

import { readFileSync } from 'node:fs'
import { generateUlid, generateCuid, generateNanoid, ID_GENERATORS, GENERATED_DEFAULTS, mintId }
  from '../../src/ids/ids.js'

const many = (fn, n = 500) => Array.from({ length: n }, () => fn())

// ─── shapes ───────────────────────────────────────────────────────────────────

test('ids: ulid is 26 chars of Crockford base32', function () {
  for (const id of many(generateUlid)) {
    assert.equal(id.length, 26)
    assert.equal(/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id), true)
  }
})

test('ids: ulid sorts by the millisecond it was minted', function () {
  // The timestamp is the first 10 characters, so lexical order is time order —
  // which is the only reason to choose a ulid over a uuid.
  const early = generateUlid()
  const later = generateUlid()
  assert.equal(early.slice(0, 10) <= later.slice(0, 10), true)
})

test('ids: cuid is c + 24 base36', function () {
  for (const id of many(generateCuid)) {
    assert.equal(id.length, 25)
    assert.equal(/^c[0-9a-z]{24}$/.test(id), true)
  }
})

test('ids: nanoid is 21 url-safe chars and takes a size', function () {
  for (const id of many(generateNanoid)) assert.equal(id.length, 21)
  assert.equal(generateNanoid(8).length, 8)
  for (const id of many(generateNanoid)) assert.equal(/^[A-Za-z0-9_-]{21}$/.test(id), true)
})

// ─── they do not repeat ───────────────────────────────────────────────────────

test('ids: every generator is collision-free over a run', function () {
  for (const [kind, gen] of Object.entries(ID_GENERATORS)) {
    const seen = new Set(many(gen, 2000))
    assert.equal(seen.size, 2000, kind + ' repeated within one run')
  }
})

// ─── the tables ───────────────────────────────────────────────────────────────

test('ids: ID_GENERATORS names the four an @id may declare', function () {
  assert.equal(Object.keys(ID_GENERATORS).sort().join(','), 'cuid,nanoid,ulid,uuid')
})

test('ids: GENERATED_DEFAULTS is the subset SQL cannot express', function () {
  // uuid() is absent on purpose — litestone's DDL writes it as a column DEFAULT,
  // and the other three emit none, so a required column declaring one could not
  // be inserted at all (FJS-423).
  assert.equal(Object.keys(GENERATED_DEFAULTS).sort().join(','), 'cuid,nanoid,ulid')
  assert.equal('uuid' in GENERATED_DEFAULTS, false)
})

test('ids: mintId answers null for a kind with no generator', function () {
  assert.equal(typeof mintId('uuid'), 'string')
  assert.equal(mintId('autoincrement'), null)
  assert.equal(mintId(undefined), null)
})

// ─── the reason it is a kit ───────────────────────────────────────────────────

test('ids: nothing here imports a node builtin', function () {
  const src = readFileSync(new URL('../../src/ids/ids.js', import.meta.url), 'utf8')
  assert.equal(/from ['"]node:/.test(src), false)
  assert.equal(/require\(/.test(src), false)
})
