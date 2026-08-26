// A FIELD predicate is compiled into SQL, on both sides (`FJS-D129`).
//
// `@guarded` is a set-membership test decided once per model, which is what let
// `guarded-filter.test.ts` close its half with a walk over the caller's
// arguments. `@allow('read'|'write', …)` on a field is a PREDICATE, and both
// halves of it were answered in the wrong place.
//
// **Read (`FJS-442`)** — the column was stripped from the answer and left fully
// filterable and sortable, so its value came back by binary search. The
// extraction below is the measurement that opened the issue.
//
// **Write (`FJS-433`)** — the predicate was evaluated in JS against the
// PAYLOAD, so `auth().id == ownerId` was wrong in both directions on an update:
// a payload omitting `ownerId` graded against `undefined` and dropped a column
// the owner was entitled to write, and a payload STATING `ownerId: me` graded
// against the caller's own assertion and wrote the column on somebody else's
// row. The second is fail-open, and it is the one to keep a test on.
//
// The two rules that make the fix correct, and each has a case here:
//
//   • the read predicate is a SIBLING of the caller's where, never a conjunct
//     inside it — otherwise their own `NOT` complements it and the oracle comes
//     back with a minus sign
//   • the write predicate reads the STORED row, which is what a bare column
//     reference is in an UPDATE — so a bulk write grades every row separately

import { describe, it, expect } from 'bun:test'
import { createClient, AccessDeniedError } from '../src/index.js'

const READ_SCHEMA = `
model Person {
  id      Int     @id
  name    String
  ownerId String
  salary  Int?    @allow('read', auth().isAdmin)
  secretN Int?    @allow('read', auth().id == ownerId)
}
`

async function people() {
  const db: any = await createClient({ db: ':memory:', schema: READ_SCHEMA })
  const sys = db.asSystem()
  await sys.person.create({ data: { id: 1, name: 'ada', ownerId: 'ada', salary: 91000, secretN: 11 } })
  await sys.person.create({ data: { id: 2, name: 'bob', ownerId: 'bob', salary: 40000, secretN: 22 } })
  return { db, sys, ada: db.$setAuth({ id: 'ada' }), admin: db.$setAuth({ id: 'zoe', isAdmin: true }) }
}

describe("@allow('read', …) on a field — the value is not recoverable by filtering", () => {

  it('still strips the column from the answer', async () => {
    const { ada } = await people()
    expect((await ada.person.findUnique({ where: { id: 1 } })).salary).toBeUndefined()
  })

  it('closes the binary-search oracle — a comparison matches no row', async () => {
    const { ada } = await people()
    // Seventeen of these recovered 91000 exactly. Every one of them answers
    // nothing now, which is what makes the sequence carry no information.
    for (const mid of [10, 50_000, 80_000, 91_000, 200_000])
      expect(await ada.person.findMany({ where: { salary: { gt: mid } } })).toHaveLength(0)
  })

  it('closes it under the caller\'s own NOT, which a per-clause conjunction would not', async () => {
    const { ada } = await people()
    // The trap `FJS-D129` names: AND the predicate INSIDE their expression and
    // `NOT ((pred) AND (salary > X))` is true for every row they may not read.
    expect(await ada.person.findMany({ where: { NOT: { salary: { gt: 50_000 } } } })).toHaveLength(0)
    // And the COST of putting it outside, stated rather than discovered: an OR
    // branch that names the column narrows the whole read, so the other branch
    // is suppressed with it. Safe (fewer rows, never more) and blunt — the
    // precise version is the masking `FJS-D129` rejected on cost. Ask the two
    // halves as two reads.
    expect(await ada.person.findMany({ where: { OR: [{ salary: { gt: 50_000 } }, { name: 'bob' }] } }))
      .toHaveLength(0)
  })

  it('refuses to let an orderBy leak the ordering of every row at once', async () => {
    const { ada } = await people()
    expect(await ada.person.findMany({ orderBy: { salary: 'desc' } })).toHaveLength(0)
  })

  it('a ROW-dependent predicate narrows to the rows the caller may read it on', async () => {
    const { ada } = await people()
    // Not a refusal: this is the case the feature exists for. Ada may compare
    // her own row's column and no one else's.
    const rows = await ada.person.findMany({ where: { secretN: { gt: 5 } } })
    expect(rows.map((r: any) => r.name)).toEqual(['ada'])
  })

  it('a caller the predicate admits filters normally', async () => {
    const { admin } = await people()
    const rows = await admin.person.findMany({ where: { salary: { gt: 50_000 } } })
    expect(rows.map((r: any) => r.name)).toEqual(['ada'])
  })

  it('asSystem() is unaffected, and so is a filter on an ordinary column', async () => {
    const { sys, ada } = await people()
    expect(await sys.person.findMany({ where: { salary: { gt: 50_000 } } })).toHaveLength(1)
    expect(await ada.person.findMany({ where: { name: 'bob' } })).toHaveLength(1)
  })
})

const REL_SCHEMA = `
model Person {
  id     Int    @id
  name   String
  salary Int?   @allow('read', auth().isAdmin)
  posts  Post[]
}
model Post {
  id       Int    @id
  title    String
  authorId Int
  author   Person @relation(fields: [authorId], references: [id])
}
`

describe('through a RELATION it is refused, because the predicate has no row there', () => {

  async function posts() {
    const db: any = await createClient({ db: ':memory:', schema: REL_SCHEMA })
    await db.asSystem().person.create({ data: { id: 1, name: 'ada', salary: 91_000 } })
    await db.asSystem().post.create({ data: { id: 1, title: 'p', authorId: 1 } })
    return db.$setAuth({ id: 'x' })
  }

  it('a relation where naming the column is refused by name', async () => {
    const db = await posts()
    await expect(db.post.findMany({ where: { author: { is: { salary: { gt: 50_000 } } } } }))
      .rejects.toThrow(AccessDeniedError)
  })

  it('so is a relation orderBy', async () => {
    const db = await posts()
    await expect(db.post.findMany({ orderBy: { author: { salary: 'asc' } } }))
      .rejects.toThrow(/RELATION/)
  })

  it('and a read that names nothing predicated is untouched', async () => {
    const db = await posts()
    expect(await db.post.findMany({ where: { title: 'p' } })).toHaveLength(1)
  })
})

const WRITE_SCHEMA = `
model Doc {
  id      Int     @id
  ownerId String  @allow('write', auth().isAdmin)
  title   String
  notes   String? @allow('write', auth().id == ownerId)
}
`

describe("@allow('write', …) on a field — the predicate reads the STORED row", () => {

  async function docs() {
    const db: any = await createClient({ db: ':memory:', schema: WRITE_SCHEMA })
    const sys = db.asSystem()
    await sys.doc.create({ data: { id: 1, ownerId: 'alice', title: 'a', notes: 'mine' } })
    await sys.doc.create({ data: { id: 2, ownerId: 'bob',   title: 'b', notes: 'bobs' } })
    return { db, sys, alice: db.$setAuth({ id: 'alice' }) }
  }
  const notesOf = (sys: any, id: number) => sys.doc.findUnique({ where: { id } }).then((r: any) => r.notes)

  it('the owner writes their own row with a payload that does not mention ownerId', async () => {
    const { sys, alice } = await docs()
    await alice.doc.update({ where: { id: 1 }, data: { notes: 'edited' } })
    // Graded against the payload, `auth().id == ownerId` compared against
    // undefined here and silently dropped the column.
    expect(await notesOf(sys, 1)).toBe('edited')
  })

  it('a caller cannot ASSERT ownership of somebody else\'s row — the fail-open half', async () => {
    const { sys, alice } = await docs()
    await alice.doc.update({ where: { id: 2 }, data: { notes: 'HACKED', ownerId: 'alice' } })
    expect(await notesOf(sys, 2)).toBe('bobs')
  })

  it('a bulk update grades every row separately', async () => {
    const { sys, alice } = await docs()
    await alice.doc.updateMany({ where: {}, data: { notes: 'bulk' } })
    expect(await notesOf(sys, 1)).toBe('bulk')
    expect(await notesOf(sys, 2)).toBe('bobs')
  })

  it('on CREATE the payload IS the row, so it is graded against it', async () => {
    const { db, sys } = await docs()
    const zoe = db.$setAuth({ id: 'zoe', isAdmin: true })
    const own = await zoe.doc.create({ data: { id: 9, ownerId: 'zoe', title: 'z', notes: 'seeded' } })
    expect(own.notes).toBe('seeded')

    const other = await zoe.doc.create({ data: { id: 8, ownerId: 'someone-else', title: 'x', notes: 'nope' } })
    expect(other.notes).toBeNull()
  })

  it('asSystem() writes it regardless', async () => {
    const { sys } = await docs()
    const row = await sys.doc.update({ where: { id: 2 }, data: { notes: 'sys' } })
    expect(row.notes).toBe('sys')
  })
})
