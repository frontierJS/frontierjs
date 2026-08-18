// test/write-operators.test.ts
//
// `{ views: { increment: 1 } }` — the write payload's one non-value shape.
//
// It exists because read-modify-write LOSES data: two callers read the same
// counter, both add one, and the second write overwrites the first. `@version`
// does not fix that, it turns it into a thrown conflict the caller has to
// retry. `UPDATE t SET views = views + ?` needs no read and cannot race
// (FJS-D27).
//
// The objection this had to answer is that the payload is otherwise VALUES, so
// `{ views: { increment: 1 } }` and `{ addr: { city: 'x' } }` are one shape.
// They are not one shape to a parser that knows the column, and the rule here
// is that the DECLARED TYPE decides: an operator is read as an operator only on
// a column that can carry it, and everything else is refused BY NAME. Half this
// file is those refusals, because a silently-wrong write is what the feature is
// for.

import { describe, test, expect, beforeEach } from 'bun:test'
import { createClient } from '../src/index.js'

const SCHEMA = `
  enum Tag { red  green  blue }
  type Addr { city String }

  model Post {
    id     Int      @id
    title  String
    views  Int      @default(0)
    rating Float    @default(1)
    tags   Tag[]
    words  String[]
    fresh  String[]?
    capped Int      @default(0) @lte(10)
    addr   Json?    @type(Addr)
  }
`

let db: any

beforeEach(async () => {
  db = (await createClient({ db: ':memory:', schema: SCHEMA })).asSystem()
  await db.post.create({ data: { id: 1, title: 't', tags: ['red'], words: ['a'] } })
})

const upd = (data: any, id = 1) => db.post.update({ where: { id }, data })
const thrown = (p: Promise<unknown>) => p.then(() => null, (e: any) => e)
const msg = (e: any) => e.errors?.[0]?.message ?? e.message

describe('numeric operators', () => {
  test('increment, decrement, multiply, divide', async () => {
    expect((await upd({ views: { increment: 5 } })).views).toBe(5)
    expect((await upd({ views: { decrement: 2 } })).views).toBe(3)
    expect((await upd({ rating: { multiply: 8 } })).rating).toBe(8)
    expect((await upd({ rating: { divide: 4 } })).rating).toBe(2)
  })

  test('several columns and a plain value in one write', async () => {
    const r = await upd({ title: 'new', views: { increment: 2 }, rating: { multiply: 3 } })
    expect([r.title, r.views, r.rating]).toEqual(['new', 2, 3])
  })

  // The whole reason the operator exists. Read-modify-write loses one of two
  // increments; the operator does not, because there is nothing to read.
  test('an interleaved write loses an increment; the operator does not', async () => {
    const readModifyWrite = async (seen: number) => upd({ views: seen + 1 })
    const seenByBoth = (await db.post.findUnique({ where: { id: 1 } })).views
    await readModifyWrite(seenByBoth)
    await readModifyWrite(seenByBoth)
    expect((await db.post.findUnique({ where: { id: 1 } })).views).toBe(1)   // two writes, one increment

    await upd({ views: 0 })
    await upd({ views: { increment: 1 } })
    await upd({ views: { increment: 1 } })
    expect((await db.post.findUnique({ where: { id: 1 } })).views).toBe(2)
  })

  test('updateMany applies it to every matching row', async () => {
    await db.post.create({ data: { id: 2, title: 'u', views: 10 } })
    expect(await db.post.updateMany({ where: {}, data: { views: { increment: 1 } } })).toEqual({ count: 2 })
    expect((await db.post.findMany({ orderBy: { id: 'asc' } })).map((p: any) => p.views)).toEqual([1, 11])
  })
})

describe('push', () => {
  test('one value, and several in one statement', async () => {
    expect((await upd({ tags: { push: 'blue' } })).tags).toEqual(['red', 'blue'])
    expect((await upd({ words: { push: ['b', 'c'] } })).words).toEqual(['a', 'b', 'c'])
  })

  test('an array column nothing has written yet', async () => {
    expect((await upd({ fresh: { push: 'first' } })).fresh).toEqual(['first'])
  })


  test('an empty push is a no-op rather than a broken statement', async () => {
    expect((await upd({ words: { push: [] } })).words).toEqual(['a'])
  })

  test('a member the enum does not declare is refused by name', async () => {
    expect(msg(await thrown(upd({ tags: { push: 'purple' } }))))
      .toMatch(/not a member of Tag \(red, green, blue\)/)
  })
})

describe('what is refused, and why', () => {
  test('a typed Json column still takes an object — the column decides', async () => {
    expect((await upd({ addr: { city: 'NYC' } })).addr).toEqual({ city: 'NYC' })
  })

  test('the operator has to match the column', async () => {
    expect(msg(await thrown(upd({ title:  { increment: 1 } })))).toMatch(/needs a numeric column and title is String/)
    expect(msg(await thrown(upd({ title:  { push: 'x' } })))).toMatch(/needs an array column and title is String/)
    expect(msg(await thrown(upd({ tags:   { increment: 1 } })))).toMatch(/needs a numeric column and tags is Tag\[\]/)
  })

  test('an operator on create is a caller who thinks they are updating', async () => {
    const e = await thrown(db.post.create({ data: { id: 9, title: 'x', views: { increment: 1 } } }))
    expect(msg(e)).toMatch(/belongs on update, not create/)
  })

  // SQLite answers NULL for x/0 and raises nothing, so the column would empty.
  test('divide by zero', async () => {
    expect(msg(await thrown(upd({ rating: { divide: 0 } })))).toMatch(/would set rating to NULL/)
  })

  test('a non-finite operand', async () => {
    expect(msg(await thrown(upd({ views: { increment: Infinity } })))).toMatch(/takes a finite number/)
    expect(msg(await thrown(upd({ views: { increment: '2' as any } })))).toMatch(/takes a finite number, got string/)
  })

  // The new value is computed inside SQLite, where validate() never sees it.
  // Refused rather than skipped: a validator that quietly stops applying is
  // worse than one that says it cannot.
  test('a column carrying a bound the operator would escape', async () => {
    expect(msg(await thrown(upd({ capped: { increment: 1 } }))))
      .toMatch(/capped carries @lte, and "increment" computes its new value inside SQLite/)
  })

  test('two operators on one column, and an operator mixed with a value', async () => {
    expect(msg(await thrown(upd({ views: { increment: 1, decrement: 1 } })))).toMatch(/was given 2 operators/)
    expect(msg(await thrown(upd({ views: { increment: 1, other: 2 } })))).toMatch(/an operator stands alone/)
  })

  test('an unknown operator is the object-where-a-value-belongs refusal, and it lists them', async () => {
    const m = msg(await thrown(upd({ views: { bogus: 1 } })))
    expect(m).toMatch(/increment, decrement, multiply, divide/)
    expect(m).toMatch(/push on an array one/)
  })
})
