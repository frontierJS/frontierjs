// `@from` — what it correlates on, and what it refuses.
//
// Two defects, one attribute, both silent:
//
//   • **FJS-377** — a composite-key relation correlated on its FIRST column
//     alone, so the aggregate counted every row sharing that column. The grid
//     below is built so each candidate join gives a different answer: correct
//     is 3/5/7, a join on `workspaceId` alone gives 8/8/7, one on `userId`
//     alone 10/5/10. Nothing raised it — the number is a count of real rows,
//     and it answers a question nobody asked.
//
//   • **FJS-395** — a write NAMING a @from field was accepted and dropped. It
//     was the one virtual field kind that did not refuse by name: @computed,
//     @derived, @generated, @transient, @system and @guarded all throw a
//     sentence saying which attribute and why.

import { describe, it, expect } from 'bun:test'
import { createClient } from '../src/index.js'

// ─── composite correlation (FJS-377) ─────────────────────────────────────────

const COMPOSITE = `
model Membership {
  id          Int    @id @default(autoincrement())
  workspaceId Int
  userId      Int
  noteCount   Int    @from(Note, count: true)
  spend       Int    @from(Note, sum: cost)
  anyNote     Boolean @from(Note, exists: true)
  latest      Note?  @from(Note, last: true)
  notes       Note[]
  @@unique([workspaceId, userId])
}
model Note {
  id          Int        @id @default(autoincrement())
  workspaceId Int
  userId      Int
  cost        Int        @default(1)
  member      Membership @relation(fields: [workspaceId, userId], references: [workspaceId, userId])
}
`

// (workspace, user, how many notes) — no two rows share both key columns, and
// each single column is shared by two rows.
const GRID = [[1, 10, 3], [1, 20, 5], [2, 10, 7]]

async function grid(schema = COMPOSITE) {
  const db: any = await createClient({ db: ':memory:', schema })
  const sys = db.asSystem()
  for (const [workspaceId, userId] of GRID) await sys.membership.create({ data: { workspaceId, userId } })
  for (const [workspaceId, userId, n] of GRID)
    for (let i = 0; i < n; i++) await sys.note.create({ data: { workspaceId, userId, cost: 10 } })
  return { db, sys }
}

describe('@from across a composite key (FJS-377)', () => {
  it('counts the rows matching EVERY key column, not the first', async () => {
    const { sys } = await grid()
    const rows = await sys.membership.findMany({ orderBy: { id: 'asc' } })
    expect(rows.map((r: any) => r.noteCount)).toEqual([3, 5, 7])
  })

  it('sums and exists correlate the same way', async () => {
    const { sys } = await grid()
    const rows = await sys.membership.findMany({ orderBy: { id: 'asc' } })
    expect(rows.map((r: any) => r.spend)).toEqual([30, 50, 70])
    expect(rows.map((r: any) => r.anyNote)).toEqual([true, true, true])
  })

  it('picks the last row by the whole key', async () => {
    const { sys } = await grid()
    const rows = await sys.membership.findMany({ orderBy: { id: 'asc' } })
    // Notes are created grid-order, so the last note of (1,10) is id 3.
    expect(rows.map((r: any) => r.latest?.id)).toEqual([3, 8, 15])
    for (const r of rows) {
      expect(r.latest.workspaceId).toBe(r.workspaceId)
      expect(r.latest.userId).toBe(r.userId)
    }
  })

  it('repicks under a row policy on the whole key', async () => {
    // A policy on the target sends `last:` down the ROW_NUMBER() repick rather
    // than the id the startup subquery chose — the other place the correlation
    // is spelled, and the one a single-column partition would silently merge.
    const { db } = await grid(COMPOSITE.replace(
      'model Note {', 'model Note {\n  @@allow(\'read\', cost > 0)'))
    const rows = await db.$setAuth({ id: 1 }).membership.findMany({ orderBy: { id: 'asc' } })
    expect(rows.map((r: any) => r.latest?.id)).toEqual([3, 8, 15])
    expect(rows.map((r: any) => [r.latest.workspaceId, r.latest.userId]))
      .toEqual([[1, 10], [1, 20], [2, 10]])
  })

  it('a select naming only the @from field still correlates', async () => {
    // The key columns are injected into the SQL and out of the answer; with a
    // composite key that is every column of it, not the first.
    const { db } = await grid(COMPOSITE.replace(
      'model Note {', 'model Note {\n  @@allow(\'read\', cost > 0)'))
    const rows = await db.$setAuth({ id: 1 })
      .membership.findMany({ select: { id: true, noteCount: true, latest: true }, orderBy: { id: 'asc' } })
    expect(rows.map((r: any) => r.noteCount)).toEqual([3, 5, 7])
    expect(rows.map((r: any) => r.latest?.id)).toEqual([3, 8, 15])
    expect(rows[0].workspaceId).toBeUndefined()
  })

  it('a single-column relation is unchanged', async () => {
    const db: any = await createClient({ db: ':memory:', schema: `
model Author {
  id        Int    @id
  noteCount Int    @from(Note, count: true)
  notes     Note[]
}
model Note {
  id       Int    @id @default(autoincrement())
  authorId Int
  author   Author @relation(fields: [authorId], references: [id])
}
` })
    const sys = db.asSystem()
    await sys.author.create({ data: { id: 1 } })
    await sys.author.create({ data: { id: 2 } })
    for (let i = 0; i < 4; i++) await sys.note.create({ data: { authorId: 1 } })
    const rows = await sys.author.findMany({ orderBy: { id: 'asc' } })
    expect(rows.map((r: any) => r.noteCount)).toEqual([4, 0])
  })
})

// ─── writing one (FJS-395) ───────────────────────────────────────────────────

const WRITE = `
model Author {
  id        Int    @id
  first     String
  noteCount Int    @from(Note, count: true)
  notes     Note[]
}
model Note {
  id       Int    @id @default(autoincrement())
  authorId Int
  author   Author @relation(fields: [authorId], references: [id])
}
`

describe('writing a @from field (FJS-395)', () => {
  it('refuses a create naming it, by name', async () => {
    const db: any = await createClient({ db: ':memory:', schema: WRITE })
    const p = db.asSystem().author.create({ data: { id: 1, first: 'A', noteCount: 99 } })
    await expect(p).rejects.toThrow(/noteCount is @from\(Note, count\)/)
    await expect(p).rejects.toThrow(/cannot be written/)
  })

  it('refuses an update naming it', async () => {
    const db: any = await createClient({ db: ':memory:', schema: WRITE })
    const sys = db.asSystem()
    await sys.author.create({ data: { id: 1, first: 'A' } })
    await expect(sys.author.update({ where: { id: 1 }, data: { noteCount: 42 } }))
      .rejects.toThrow(/@from/)
  })

  it('says where the value comes from instead', async () => {
    const db: any = await createClient({ db: ':memory:', schema: WRITE })
    try {
      await db.asSystem().author.create({ data: { id: 1, first: 'A', noteCount: 99 } })
      throw new Error('should have refused')
    } catch (e: any) {
      expect(e.message).toMatch(/Write the Note rows it counts instead/)
    }
  })

  it('a write that leaves it alone still lands, and it reads the count', async () => {
    const db: any = await createClient({ db: ':memory:', schema: WRITE })
    const sys = db.asSystem()
    await sys.author.create({ data: { id: 1, first: 'A' } })
    await sys.note.create({ data: { authorId: 1 } })
    expect((await sys.author.findUnique({ where: { id: 1 } })).noteCount).toBe(1)
  })
})
