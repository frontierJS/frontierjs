// FJS-934 — a `where` that is not an object was ignored, and on a bulk verb
// that means the whole table.
//
// `buildWhere` walks the value's entries looking for columns. A number, a
// boolean, anything with no own enumerable keys yields none, so it emits NO
// CLAUSE — byte-identical to what an absent `where` emits. `deleteMany({ where:
// 5 })` therefore destroyed every row and answered `{count: 3}`.
//
// The other half fails the opposite way and is quieter: a string's entries ARE
// keys — its character indices — so `where: 'title'` compiles to a predicate
// over columns named `0`, `1`, `2`, matches nothing, and answers `[]`. One
// malformed shape reached every row, another reached none, and neither said
// anything.
//
// `where: {}` is the deliberate spelling for every row and is asserted here
// beside each refusal, because a guard that refused the empty object too would
// satisfy every test that only asks about the malformed values — and it would
// break `truncate`, `reset` and the single `delete`'s own error message, which
// names `deleteMany({})` as the way to delete all rows.

import { describe, it, expect } from 'bun:test'
import { createClient } from '../src/index.js'

const SCHEMA = `
model Note {
  id    Int    @id @default(autoincrement())
  title String
}
`

const open = async () => {
  const db: any = await createClient({ db: ':memory:', schema: SCHEMA })
  for (const title of ['a', 'b', 'c']) await db.note.create({ data: { title } })
  return db
}

const refusal = async (fn: () => Promise<unknown>) => {
  try { await fn(); return null }
  catch (e: any) { return String(e.message) }
}

const BAD = { number: 5, string: 'title', array: ['title'], boolean: true }

describe('FJS-934 — the where container', () => {
  it('a malformed where cannot destroy the table', async () => {
    for (const [kind, bad] of Object.entries(BAD)) {
      const db = await open()
      expect(await refusal(() => db.note.deleteMany({ where: bad })), kind).toContain('must be an object')
      expect(await db.note.count(), kind).toBe(3)
      db.$close()
    }
  })

  // Three verbs reach every row when the clause is dropped, and they are three
  // different code paths.
  it('updateMany and removeMany refuse it too, and change nothing', async () => {
    const db = await open()
    expect(await refusal(() => db.note.updateMany({ where: 5, data: { title: 'X' } })))
      .toContain('must be an object')
    expect(await refusal(() => db.note.removeMany({ where: 5 }))).toContain('must be an object')
    expect(await db.note.findMany()).toEqual([
      { id: 1, title: 'a' }, { id: 2, title: 'b' }, { id: 3, title: 'c' },
    ])
    db.$close()
  })

  it('a read refuses it as well, rather than answering every row or none', async () => {
    const db = await open()
    for (const [kind, bad] of Object.entries(BAD)) {
      const db2 = await open()
      expect(await refusal(() => db2.note.findMany({ where: bad })), kind).toContain('must be an object')
      db2.$close()
    }
    expect(await refusal(() => db.note.count({ where: 5 }))).toContain('must be an object')
    db.$close()
  })

  it('the refusal says what it is and what to write instead', async () => {
    const db = await open()
    const msg = await refusal(() => db.note.deleteMany({ where: ['id'] }))
    expect(msg).toContain('an array')
    expect(msg).toContain('every row in the table')
    expect(msg).toContain('pass {}')
    db.$close()
  })

  // The controls. Absent, null and {} all mean every row, deliberately — this
  // is the line the guard has to stop at, and `truncate`/`reset`/the seeder all
  // sit on the far side of it.
  it('an absent, null or empty where still means every row', async () => {
    for (const run of [
      (db: any) => db.note.deleteMany(),
      (db: any) => db.note.deleteMany({}),
      (db: any) => db.note.deleteMany({ where: {} }),
      (db: any) => db.note.deleteMany({ where: null }),
    ]) {
      const db = await open()
      expect(await run(db)).toEqual({ count: 3 })
      expect(await db.note.count()).toBe(0)
      db.$close()
    }
  })

  // These are the shapes an accidentally-empty filter actually arrives in, and
  // all three were already safe. Kept as a boundary: a fix that made the
  // container check swallow them would be a regression nothing else can see.
  it('a narrowing that went missing is still refused or still matches nothing', async () => {
    const db = await open()
    const missing: any = undefined
    expect(await refusal(() => db.note.deleteMany({ where: { id: missing } }))).toContain('undefined')
    expect(await db.note.deleteMany({ where: { id: { in: [] } } })).toEqual({ count: 0 })
    expect(await db.note.count()).toBe(3)
    db.$close()
  })
})
