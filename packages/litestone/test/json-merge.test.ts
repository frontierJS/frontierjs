// test/json-merge.test.ts
//
// `{ settings: { $merge: { commute: { source } } } }` — changing one key of a
// document without reading it first.
//
// It exists for the reason every atomic operator here exists: read-modify-write
// loses a concurrent change, and `@version` only turns that into a conflict the
// caller has to retry. What is different about this one is that it is the only
// operator whose column can legitimately hold an object, which is why it wears
// a `$` — `{ doc: { increment: 1 } }` on a Json column stores `{"increment":1}`
// as the document, and `merge` as a bare word would do the same.
//
// The grading is the substance, and the rule is not the obvious one. RFC 7396
// REPLACES rather than merges when the target at a path is absent or null, so a
// patch aimed at an optional field is a create however partial it looks, and
// the required keys of that type are not optional after all. Measured as 2
// counterexamples in 68 before the rule was repaired; the repaired rule is
// sound over 90 (stored × patch) pairs at three levels of nesting, and the
// proof is `IDEAS/json-document-writes.md` § The claim, verified.

import { describe, test, expect, beforeEach } from 'bun:test'
import { createClient } from '../src/index.js'

const SCHEMA = `
  type Geo      { lat Float  lng Float }
  type Commute  { source String  minutes Int  geo Json? @type(Geo) }
  type Notify   { email Boolean  push Boolean? }
  type Settings {
    theme    String
    count    Int?
    commute  Json? @type(Commute)
    notify   Json  @type(Notify)
    tags     String[]
  }

  model Account {
    id     Int     @id
    name   String
    doc    Json    @default("{}")
    typ    Json    @type(Settings)
    opt    Json?   @type(Settings)
    token  Json    @secret @default("{}")
    n      Int     @default(0)
    words  String[]
  }
`
const KEY  = '0'.repeat(64)
const FULL = { theme: 'd', count: 1, commute: { source: 'bus', minutes: 20 }, notify: { email: true }, tags: ['x'] }

let db: any
beforeEach(async () => {
  // @secret on `token` needs a key — the column is here so the ciphertext
  // refusal has something real to refuse.
  db = (await createClient({ db: ':memory:', schema: SCHEMA, encryptionKey: KEY })).asSystem()
  await db.account.create({ data: { id: 1, name: 'a', doc: { a: 1, b: { c: 2 } }, typ: FULL, words: ['w'] } })
})

const upd    = (data: any) => db.account.update({ where: { id: 1 }, data })
const thrown = (p: Promise<unknown>) => p.then(() => null, (e: any) => e)
const msg    = (e: any) => e?.errors?.[0]?.message ?? e?.message ?? ''
// path + message, for the assertions that are about WHICH field was refused.
const at     = (e: any) => e?.errors?.[0] ? `${e.errors[0].path.join('.')}: ${e.errors[0].message}` : (e?.message ?? '')
const row    = () => db.account.findUnique({ where: { id: 1 } })

describe('an undescribed column — nothing to grade', () => {
  // No declared shape means no invariant a merge can break, so every one of
  // these is legal. That is not laxity, it is the same answer a whole-document
  // write to this column already gives.
  test('adds, replaces and merges nested objects', async () => {
    expect((await upd({ doc: { $merge: { d: 9 } } })).doc).toEqual({ a: 1, b: { c: 2 }, d: 9 })
    expect((await upd({ doc: { $merge: { a: 5 } } })).doc).toEqual({ a: 5, b: { c: 2 }, d: 9 })
    expect((await upd({ doc: { $merge: { b: { z: 1 } } } })).doc).toEqual({ a: 5, b: { c: 2, z: 1 }, d: 9 })
  })

  // RFC 7396: null DELETES. Invariant 9's word one level down, and the sharpest
  // edge in the feature — the same payload means "set to null" on a column.
  test('null deletes a key rather than setting it to null', async () => {
    expect((await upd({ doc: { $merge: { a: null } } })).doc).toEqual({ b: { c: 2 } })
  })

  test('an array is replaced whole, never merged element-wise', async () => {
    await upd({ doc: { $merge: { list: [1, 2, 3] } } })
    expect((await upd({ doc: { $merge: { list: [9] } } })).doc.list).toEqual([9])
  })

  test('an empty patch is a no-op', async () => {
    const before = (await row()).doc
    expect((await upd({ doc: { $merge: {} } })).doc).toEqual(before)
  })

  // json_patch(NULL, …) answers NULL and raises nothing, which would EMPTY the
  // column rather than fill it. The coalesce is what stops that.
  test('a column standing at null is filled, not emptied', async () => {
    await db.account.create({ data: { id: 2, name: 'b', typ: FULL, words: [] } })
    await db.account.update({ where: { id: 2 }, data: { opt: null } })
    const r = await db.account.update({ where: { id: 2 }, data: { doc: { $merge: { fresh: 1 } } } })
    expect(r.doc).toEqual({ fresh: 1 })
  })
})

describe('a described column — the patch is graded', () => {
  test('a partial patch is accepted and leaves the other keys alone', async () => {
    expect((await upd({ typ: { $merge: { count: 7 } } })).typ).toEqual({ ...FULL, count: 7 })
  })

  test('a partial patch into a REQUIRED nested field stays partial', async () => {
    expect((await upd({ typ: { $merge: { notify: { push: true } } } })).typ.notify).toEqual({ email: true, push: true })
  })

  test('an unknown key is refused by name', async () => {
    expect(msg(await thrown(upd({ typ: { $merge: { nope: 1 } } }))))
      .toMatch(/unknown field — type Settings has no 'nope'/)
  })

  test('a wrong type is refused', async () => {
    expect(msg(await thrown(upd({ typ: { $merge: { theme: 7 } } })))).toMatch(/must be a string/)
  })

  // The delete case, graded: null on a key the type requires would produce a
  // document the column may not hold.
  test('null on a required key is refused, naming the delete', async () => {
    expect(msg(await thrown(upd({ typ: { $merge: { theme: null } } }))))
      .toMatch(/null would delete 'theme', and type Settings requires it/)
    expect(msg(await thrown(upd({ typ: { $merge: { tags: null } } })))).toMatch(/null would delete 'tags'/)
  })

  test('null on an OPTIONAL key deletes it and is fine', async () => {
    expect((await upd({ typ: { $merge: { count: null } } })).typ.count).toBeUndefined()
  })

  test('the column is unchanged when the patch is refused', async () => {
    await thrown(upd({ typ: { $merge: { theme: null } } }))
    expect((await row()).typ).toEqual(FULL)
  })
})

// ─── the rule the design turns on ───────────────────────────────────────────
//
// json_patch REPLACES a null or absent target. So a partial patch into an
// OPTIONAL field is a create, and every required key of that type must be in
// it. Decidable statically — a required field is present in every valid parent
// by induction from the column's own type — so the operator still needs no read.
describe('a patch into something that may not be there is a CREATE', () => {
  test('a partial patch into an optional nested field is refused, and says why', async () => {
    const m = msg(await thrown(upd({ typ: { $merge: { commute: { source: 'car' } } } })))
    expect(m).toMatch(/is required/)
    expect(m).toMatch(/json_patch replaces rather than merges when it is absent/)
    expect(m).toMatch(/creates a whole Commute/)
  })

  test('the same patch complete is accepted', async () => {
    expect((await upd({ typ: { $merge: { commute: { source: 'car', minutes: 9 } } } })).typ.commute)
      .toEqual({ source: 'car', minutes: 9 })
  })

  // Three levels: geo is optional inside commute, which is optional inside
  // Settings, so both hops downgrade.
  test('it applies at every depth', async () => {
    expect(at(await thrown(upd({ typ: { $merge: { commute: { source: 'c', minutes: 2, geo: { lat: 9 } } } } }))))
      .toMatch(/^typ\.commute\.geo\.lng: is required/)
    expect((await upd({ typ: { $merge: { commute: { source: 'c', minutes: 2, geo: { lat: 9, lng: 8 } } } } })).typ.commute.geo)
      .toEqual({ lat: 9, lng: 8 })
  })

  // The same rule one level up: the COLUMN itself may stand at null.
  test('a nullable described column is graded as a create', async () => {
    expect(at(await thrown(upd({ opt: { $merge: { count: 3 } } })))).toMatch(/^opt\.theme: is required/)
    expect((await upd({ opt: { $merge: { theme: 'x', notify: { email: false }, tags: [] } } })).opt)
      .toEqual({ theme: 'x', notify: { email: false }, tags: [] })
  })

  // The negative control for the whole block: a REQUIRED nested field is
  // guaranteed present, so it is NOT downgraded. Without this, a rule that
  // graded everything as a create would pass every assertion above.
  test('a required nested field is not downgraded', async () => {
    expect((await upd({ typ: { $merge: { notify: { push: false } } } })).typ.notify).toEqual({ email: true, push: false })
  })
})

describe('which operations take it', () => {
  test('update and updateMany', async () => {
    expect((await upd({ doc: { $merge: { u: 1 } } })).doc.u).toBe(1)
    await db.account.updateMany({ where: {}, data: { doc: { $merge: { m: 2 } } } })
    expect((await row()).doc.m).toBe(2)
  })

  // There is no stored value to merge into, so an operator here is a caller who
  // thinks they are updating — the same sentence the other five give.
  test.each([
    ['create',     () => db.account.create({ data: { id: 9, name: 'x', typ: FULL, words: [], doc: { $merge: { a: 1 } } } })],
    ['createMany', () => db.account.createMany({ data: [{ id: 9, name: 'x', typ: FULL, words: [], doc: { $merge: { a: 1 } } }] })],
    ['upsert',     () => db.account.upsert({ where: { id: 1 }, create: { id: 1, name: 'x', typ: FULL, words: [] }, update: { doc: { $merge: { a: 1 } } } })],
  ])('%s refuses it by name', async (_l, call) => {
    expect(msg(await thrown(call()))).toMatch(/"\$merge" merges into a document that is already there, so it belongs on update, not (create|createMany|upsert)/)
  })
})

describe('the refusals', () => {
  test('a column that is not a document', async () => {
    expect(msg(await thrown(upd({ n:     { $merge: { a: 1 } } })))).toMatch(/merges into a document and n is Int/)
    expect(msg(await thrown(upd({ words: { $merge: { a: 1 } } })))).toMatch(/merges into a document and words is String\[\]/)
  })

  // The stored text is ciphertext, so json_patch would merge into base64 and
  // produce something that is neither. Same class as push on a non-array.
  test('an encrypted column', async () => {
    expect(msg(await thrown(upd({ token: { $merge: { a: 1 } } })))).toMatch(/is @secret, so what is stored is ciphertext/)
  })

  test('a patch that is not an object', async () => {
    expect(msg(await thrown(upd({ doc: { $merge: 5 } })))).toMatch(/takes an object of the keys to change, got number/)
    expect(msg(await thrown(upd({ doc: { $merge: [1] } })))).toMatch(/got an array/)
    expect(msg(await thrown(upd({ doc: { $merge: null } })))).toMatch(/got null/)
  })

  test('mixed with anything else', async () => {
    expect(msg(await thrown(upd({ doc: { $merge: { a: 1 }, other: 2 } })))).toMatch(/an operator stands alone/)
  })

  test('a key that is not a column, and a path', async () => {
    expect(msg(await thrown(upd({ nope:    { $merge: { a: 1 } } })))).toMatch(/nope is not a column on Account/)
    expect(msg(await thrown(upd({ 'doc.a': { $merge: { b: 1 } } })))).toMatch(/reads as a path into "doc"/)
  })

  // A document key spelled like an operator is still a VALUE, which is the
  // whole reason this operator wears a `$`.
  test('a document key spelled like an operator is untouched', async () => {
    expect((await upd({ doc: { $merge: { increment: 1, push: 'x' } } })).doc)
      .toEqual({ a: 1, b: { c: 2 }, increment: 1, push: 'x' })
  })
})

describe('what it inherits by being an ordinary write', () => {
  // The reason to build it here rather than reach for asSystem().sql json_set:
  // every rule on the write path still applies. A field write predicate is the
  // one that had to be checked, because an operator went round it until
  // FJS-661 — and $merge is spliced into the SET clause the same way.
  test('a field @allow(write) predicate still applies', async () => {
    const client: any = await createClient({ db: ':memory:', schema: `
      model Doc {
        id  Int  @id
        d   Json @default("{}") @allow('write', auth().role == 'admin')
        @@gate("0.0.0.0")
      }` })
    await client.asSystem().doc.create({ data: { id: 1, d: { a: 1 } } })
    const stored = () => client.asSystem().doc.findUnique({ where: { id: 1 } })

    await client.$setAuth({ id: 'u', role: 'user'  }).doc.update({ where: { id: 1 }, data: { d: { $merge: { b: 2 } } } })
    expect((await stored()).d).toEqual({ a: 1 })

    await client.$setAuth({ id: 'v', role: 'admin' }).doc.update({ where: { id: 1 }, data: { d: { $merge: { b: 2 } } } })
    expect((await stored()).d).toEqual({ a: 1, b: 2 })
  })

  test('it returns the merged document', async () => {
    expect((await upd({ doc: { $merge: { r: 1 } } })).doc).toEqual({ a: 1, b: { c: 2 }, r: 1 })
  })

  // The point of the operator. Two callers changing different keys both land;
  // read-modify-write drops one, which is written out here as the control.
  test('two merges of different keys both land, where read-modify-write loses one', async () => {
    const seen = (await row()).doc
    await upd({ doc: { ...seen, x: 1 } })
    await upd({ doc: { ...seen, y: 2 } })
    const rmw = (await row()).doc
    expect(rmw.x).toBeUndefined()          // the first write is gone
    expect(rmw.y).toBe(2)

    await upd({ doc: { $merge: { x: 1 } } })
    await upd({ doc: { $merge: { y: 2 } } })
    const merged = (await row()).doc
    expect([merged.x, merged.y]).toEqual([1, 2])
  })
})
