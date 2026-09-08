// identifier-refusals.test.ts — Invariant 8, executed.
//
// *A caller-supplied name never enters a SQL pattern.* Until this file the
// invariant had no enforcer at all — `invariants.snapshot.md` recorded **none**
// against it, which is the state `FJS-D190` names as the worst one: an
// unenforced invariant reads exactly like an enforced one from every document
// that cites it.
//
// It is held by REFUSAL rather than by quoting. Every door a caller can name a
// column through grades that name against the model and throws by name; nothing
// unvalidated reaches the emitter, and `quoteIdent` is the escape for the few
// sites that emit one anyway. That division is why the enforcement lives here
// and not in a test over `quoteIdent`.
//
// Two failures, and the second is the one that hides (`query.js`, § identifier
// quoting):
//
//   1. A name carrying a `"` closes the quote. `id" = 2) OR ("id` is enough to
//      unbalance the parentheses a row policy is ANDed inside and lift it off
//      the query — a scoped client answering somebody else's rows.
//   2. SQLite resolves a double-quoted identifier it cannot bind as a STRING
//      LITERAL rather than raising. So a name that merely does not exist
//      compares two constants, answers nothing, and reports no error. A test
//      that only asserts "no rows leaked" passes against this.
//
// **Every refusal is PAIRED with the legal name one hop away** (`FJS-351`). A
// guard that refused every name would satisfy any test asking only about the
// refusals, and would be indistinguishable from a client that reads nothing.
//
// **The last block is the invariant itself and not a proxy for it**: the tap
// records every statement the client actually sends, and the assertion is that
// the hostile string appears in none of them. `FJS-1015` was found because the
// nested `include` doors had no refusal — one put the name into a SELECT list
// unquoted, one put it in a WHERE where SQLite read it as a literal and
// answered an empty relation with no error — and both are invisible to a test
// that only asks whether a call threw.

import { describe, it, expect } from 'bun:test'
import { createClient } from '../src/index.js'

const SCHEMA = `
model Author {
  id    Int    @id @default(autoincrement())
  name  String
  posts Post[]
}
model Post {
  id       Int     @id @default(autoincrement())
  title    String
  views    Int     @default(0)
  tag      String  @default("x")
  authorId Int?
  author   Author? @relation(fields: [authorId], references: [id])
}
`

// The quote-carrying name and the merely-absent one. Both must be refused, and
// they fail differently when they are not: the first breaks the statement, the
// second is read as a string literal and answers nothing.
const CLOSES_QUOTE = 'id" = 2) OR ("id'
const ABSENT       = 'nope'
const HOSTILE      = [CLOSES_QUOTE, ABSENT]

async function seeded() {
  const db: any = await createClient({ schema: SCHEMA, db: ':memory:' })
  const a = await db.author.create({ data: { name: 'ann' } })
  await db.post.create({ data: { title: 'a', views: 1, tag: 'p', authorId: a.id } })
  await db.post.create({ data: { title: 'b', views: 2, tag: 'q', authorId: a.id } })
  return db
}

/** Every door a caller names a column through, as (bad call, legal twin). */
const DOORS: Array<{
  door:  string
  bad:   (db: any, k: string) => Promise<unknown>
  legal: (db: any) => Promise<unknown>
}> = [
  { door: 'where',
    bad:   (db, k) => db.post.findMany({ where: { [k]: 1 } }),
    legal: (db)    => db.post.findMany({ where: { title: 'a' } }) },
  { door: 'where > AND',
    bad:   (db, k) => db.post.findMany({ where: { AND: [{ [k]: 1 }] } }),
    legal: (db)    => db.post.findMany({ where: { AND: [{ title: 'a' }] } }) },
  { door: 'where > NOT',
    bad:   (db, k) => db.post.findMany({ where: { NOT: { [k]: 1 } } }),
    legal: (db)    => db.post.findMany({ where: { NOT: { title: 'a' } } }) },
  { door: 'orderBy',
    bad:   (db, k) => db.post.findMany({ orderBy: { [k]: 'asc' } }),
    legal: (db)    => db.post.findMany({ orderBy: { views: 'asc' } }) },
  { door: 'orderBy > relation hop',
    bad:   (db, k) => db.post.findMany({ orderBy: { author: { [k]: 'asc' } } }),
    legal: (db)    => db.post.findMany({ orderBy: { author: { name: 'asc' } } }) },
  { door: 'select',
    bad:   (db, k) => db.post.findMany({ select: { [k]: true } }),
    legal: (db)    => db.post.findMany({ select: { title: true } }) },
  { door: 'include > select',
    bad:   (db, k) => db.post.findMany({ include: { author: { select: { [k]: true } } } }),
    legal: (db)    => db.post.findMany({ include: { author: { select: { name: true } } } }) },
  { door: 'include > where',
    bad:   (db, k) => db.author.findMany({ include: { posts: { where: { [k]: 1 } } } }),
    legal: (db)    => db.author.findMany({ include: { posts: { where: { title: 'a' } } } }) },
  { door: 'include > orderBy',
    bad:   (db, k) => db.author.findMany({ include: { posts: { orderBy: { [k]: 'asc' } } } }),
    legal: (db)    => db.author.findMany({ include: { posts: { orderBy: { views: 'asc' } } } }) },
  { door: 'include > include',
    bad:   (db, k) => db.post.findMany({ include: { author: { include: { posts: { where: { [k]: 1 } } } } } }),
    legal: (db)    => db.post.findMany({ include: { author: { include: { posts: true } } } }) },
  { door: 'include (relation name)',
    bad:   (db, k) => db.post.findMany({ include: { [k]: true } }),
    legal: (db)    => db.post.findMany({ include: { author: true } }) },
  { door: 'groupBy > by',
    bad:   (db, k) => db.post.groupBy({ by: [k], _count: true }),
    legal: (db)    => db.post.groupBy({ by: ['tag'], _count: true }) },
  { door: 'groupBy > having',
    bad:   (db, k) => db.post.groupBy({ by: ['tag'], _count: true, having: { [k]: { gt: 0 } } }),
    legal: (db)    => db.post.groupBy({ by: ['tag'], _count: true, having: { _count: { gt: 0 } } }) },
  { door: 'groupBy > orderBy',
    bad:   (db, k) => db.post.groupBy({ by: ['tag'], _count: true, orderBy: { [k]: 'asc' } }),
    legal: (db)    => db.post.groupBy({ by: ['tag'], _count: true, orderBy: { tag: 'asc' } }) },
  { door: 'aggregate',
    bad:   (db, k) => db.post.aggregate({ _sum: { [k]: true } }),
    legal: (db)    => db.post.aggregate({ _sum: { views: true } }) },
  { door: 'count > where',
    bad:   (db, k) => db.post.count({ where: { [k]: 1 } }),
    legal: (db)    => db.post.count({ where: { title: 'a' } }) },
  { door: 'updateMany > where',
    bad:   (db, k) => db.post.updateMany({ where: { [k]: 1 }, data: { views: 9 } }),
    legal: (db)    => db.post.updateMany({ where: { title: 'a' }, data: { views: 9 } }) },
  { door: 'deleteMany > where',
    bad:   (db, k) => db.post.deleteMany({ where: { [k]: 1 } }),
    legal: (db)    => db.post.deleteMany({ where: { title: 'nothing-matches' } }) },
]

describe('Invariant 8 — a caller-supplied name is refused at every door', () => {
  for (const { door, bad } of DOORS) {
    for (const key of HOSTILE) {
      const shape = key === CLOSES_QUOTE ? 'closes the quote' : 'merely absent'
      it(`${door} refuses a name that ${shape}`, async () => {
        const db = await seeded()
        // The refusal must NAME the key. A generic "bad request" leaves a caller
        // with a typo unable to tell it from a permission answer.
        await expect(bad(db, key)).rejects.toThrow(
          new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      })
    }
  }

  // The pairing. Without these every row above is satisfied by a client that
  // refuses everything, which is the failure mode `FJS-351` is about.
  for (const { door, legal } of DOORS) {
    it(`${door} still accepts the name one hop away`, async () => {
      const db = await seeded()
      await expect(legal(db)).resolves.toBeDefined()
    })
  }
})

describe('Invariant 8 — the statement itself', () => {
  // The invariant stated directly rather than through its symptom. A refusal
  // that happened after the statement was built would pass every row above.
  it('no statement the client sends contains a caller-supplied name', async () => {
    const db = await seeded()
    const sent: string[] = []
    db.$tapQuery((e: any) => { if (e?.sql) sent.push(e.sql) })

    for (const { bad } of DOORS) {
      for (const key of HOSTILE) {
        try { await bad(db, key) } catch { /* the refusal is asserted above */ }
      }
    }

    expect(sent.length).toBeGreaterThan(0)
    const leaked = sent.filter(s => s.includes('OR (') || s.includes(ABSENT))
    expect(leaked).toEqual([])
  })

  // The second failure, asserted as a value rather than as an absence of error.
  // A quoted identifier SQLite cannot bind is a string literal, so the query
  // succeeds and answers nothing — which is why the row above cannot be the
  // whole test, and why an empty result is checked against a populated one.
  it('a refused name never answers an empty relation instead', async () => {
    const db = await seeded()
    const ok = await db.author.findMany({ include: { posts: { where: { title: 'a' } } } })
    expect(ok[0].posts).toHaveLength(1)

    await expect(
      db.author.findMany({ include: { posts: { where: { [CLOSES_QUOTE]: 1 } } } }),
    ).rejects.toThrow()
  })
})
