// test/cursor-grading.test.ts
//
// A cursor is CALLER-SUPPLIED text, and it was graded by nothing (`FJS-779`).
//
// `?$after=…` arrives from outside. `decodeCursor` parsed it and handed whatever
// came out to `buildCursorWhere`, which reads the sort columns off the SERVER's
// own `orderBy` and looks each one up in the decoded object — so a token that
// was not one this list minted found `undefined` at every key, bound NULL, and
// answered an empty page. Measured on a six-row table, ordered by `id`:
//
//   {"nope":3}      → 0 rows, 200      a cursor for another ordering
//   {}              → 0 rows, 200
//   [3]             → 0 rows, 200
//   7               → 0 rows, 200
//   {"id":{"$gt":0}}→ 0 rows, 200
//   null            → SIX rows, 200    the whole table, paged from the start
//   not-base64      → 500              a bare Error, so the server "broke"
//
// The one that happens in an application is the first: a client holds an
// `endCursor`, somebody changes the sort, and `more()` asks for the next page
// under an ordering that did not mint the token. An empty list is
// indistinguishable from the end of the data, so the window silently stops.
//
// Every refusal below is PAIRED with the CORRECT cursor for the same query
// (`FJS-351`) — a grader that refused everything would answer every test that
// only checks the refusal, and the shape being defended is exactly a list that
// answers nothing.

import { describe, test, expect } from 'bun:test'
import { createClient } from '../src/index.js'

const SCHEMA = `
  database main { path ":memory:" }

  model Post {
    id        Int      @id @default(autoincrement())
    title     String
    createdAt DateTime @default(now())
    @@db(main)
  }
`

async function seeded(n = 6) {
  const db: any = await createClient({ databases: ':memory:', schema: SCHEMA })
  for (let i = 1; i <= n; i++) await db.asSystem().post.create({ data: { title: `p${i}` } })
  return db
}

const mint = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
const ids  = (page: any) => page.items.map((r: any) => r.id)

const BY_ID = { limit: 10, orderBy: { id: 'asc' } as const }

// ─── the refusals, each beside the cursor that works ──────────────────────────

describe('a token this list did not mint is refused, not answered', () => {

  const cases: Array<[string, unknown, RegExp]> = [
    ['an object with the wrong keys', { nope: 3 },        /different ordering/],
    ['an empty object',              {},                  /different ordering/],
    ['an array',                     [3],                 /an array/],
    ['a bare number',                7,                   /decoded to number/],
    ['a bare string',                'three',             /decoded to string/],
    ['null',                         null,                /decoded to null/],
    ['a structure where a value goes', { id: { gt: 0 } },  /structure for "id"/],
    ['a list where a value goes',      { id: [1, 2] },     /list for "id"/],
  ]

  for (const [name, value, message] of cases) {
    test(`${name} — refused by name, and the right cursor still pages`, async () => {
      const db = await seeded()
      const t  = db.asSystem().post

      await expect(t.findManyCursor({ ...BY_ID, cursor: mint(value) })).rejects.toThrow(message)
      await expect(t.findManyCursor({ ...BY_ID, cursor: mint(value) })).rejects.toThrow(/\$after/)

      // The pair. Without it every row above passes against a grader that
      // refuses all cursors, which is a worse list than the one being fixed.
      const page = await t.findManyCursor({ ...BY_ID, limit: 3, cursor: mint({ id: 3 }) })
      expect(ids(page)).toEqual([4, 5, 6])
      db.$close()
    })
  }

  test('text that is not a cursor at all', async () => {
    const db = await seeded()
    await expect(db.asSystem().post.findManyCursor({ ...BY_ID, cursor: '!!!nope!!!' }))
      .rejects.toThrow(/is not a cursor this list minted/)
    // Base64 that decodes to something that is not JSON takes the same answer:
    // both are *you did not get this from us*, which is one thing to fix.
    await expect(db.asSystem().post.findManyCursor(
      { ...BY_ID, cursor: Buffer.from('hello').toString('base64url') }))
      .rejects.toThrow(/is not a cursor this list minted/)
    db.$close()
  })

  test('a ValidationError, so the boundary answers 400 and not 500', async () => {
    const db = await seeded()
    try {
      await db.asSystem().post.findManyCursor({ ...BY_ID, cursor: 'nope' })
      throw new Error('should have refused')
    } catch (err: any) {
      // The class is the whole of what junction maps — a bare Error is a 500,
      // which tells a caller who sent a bad token that the server is broken.
      expect(err.name).toBe('ValidationError')
      expect(err.errors[0].path).toEqual(['$after'])
    }
    db.$close()
  })
})

// ─── the case that actually happens ───────────────────────────────────────────

describe('a cursor is graded against the ordering using it', () => {

  test('one minted under a DIFFERENT sort is refused, naming both', async () => {
    const db = await seeded()
    const t  = db.asSystem().post

    // The real sequence: a list ordered by createdAt hands out an edge, the
    // person switches the sort, and the next page is asked for with it.
    const byDate = await t.findManyCursor({ limit: 2, orderBy: { createdAt: 'desc' } })
    expect(byDate.nextCursor).toBeTruthy()

    await expect(t.findManyCursor({ ...BY_ID, cursor: byDate.nextCursor }))
      .rejects.toThrow(/ordered by id/)
    await expect(t.findManyCursor({ ...BY_ID, cursor: byDate.nextCursor }))
      .rejects.toThrow(/createdAt/)

    // And it is still good for the list that minted it, or this is a grader
    // that has broken cursor paging rather than one that has fixed it.
    const next = await t.findManyCursor(
      { limit: 2, orderBy: { createdAt: 'desc' }, cursor: byDate.nextCursor })
    expect(next.items.length).toBeGreaterThan(0)
    expect(ids(next)).not.toEqual(ids(byDate))
    db.$close()
  })

  test('the tiebreaker is part of the key set, so a hand-built cursor is refused', async () => {
    const db = await seeded()
    const t  = db.asSystem().post

    // Ordering by createdAt alone is not total, so litestone appends the id.
    // A token naming only what the CALLER asked to sort by is therefore not one
    // this list mints, and accepting it would page by a partial order.
    await expect(t.findManyCursor(
      { limit: 2, orderBy: { createdAt: 'desc' }, cursor: mint({ createdAt: '2020-01-01' }) }))
      .rejects.toThrow(/names id nowhere/)
    db.$close()
  })

  test('a full round trip is unchanged — every row once, in order', async () => {
    const db = await seeded(7)
    const t  = db.asSystem().post

    const seen: number[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 10; guard++) {
      const page: any = await t.findManyCursor({ limit: 3, orderBy: { id: 'asc' }, cursor })
      seen.push(...ids(page))
      if (!page.hasMore) break
      cursor = page.nextCursor
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7])
    db.$close()
  })
})
