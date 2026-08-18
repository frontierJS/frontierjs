// test/bulk-count.test.ts
//
// What `{ count }` means on a bulk write: **rows of this model the statement
// addressed**, and nothing else.
//
// bun:sqlite's `.changes` is a total-changes delta, so it also counts what
// TRIGGERS and FOREIGN KEY actions wrote inside the same statement. Every
// count here was wrong before FJS-320 and the two loudest cases are ordinary:
// an `@@fts` model answered 17 for one updated row, and the `updatedAt`
// trigger — which most models carry — doubled the count on every model that
// has the column. Junction hands this number to the browser and a live store's
// `changed` event carries it, so a caller comparing it against what they asked
// for saw a write that touched rows it never named.
//
// Every model here holds exactly ONE row, so every correct answer is 1.

import { describe, test, expect, beforeEach } from 'bun:test'
import { createClient } from '../src/index.js'

const SCHEMA = `
  model Doc {
    id        Int      @id
    title     String
    body      String
    updatedAt DateTime?
    @@fts([title, body])
  }

  model Note {
    id        Int      @id
    title     String
    updatedAt DateTime?
  }

  model Bare {
    id    Int    @id
    title String
  }

  model Soft {
    id        Int       @id
    title     String
    updatedAt DateTime?
    deletedAt DateTime?
    @@softDelete
  }

  model Parent {
    id       Int    @id
    name     String
    children Child[]
  }

  model Child {
    id       Int    @id
    parent   Parent @relation(fields: [parentId], references: [id], onDelete: Cascade)
    parentId Int
  }
`

let db: any

beforeEach(async () => {
  db = await createClient({ db: ':memory:', schema: SCHEMA })
  await db.doc.create({ data: { title: 'a', body: 'one' } })
  await db.note.create({ data: { title: 'a' } })
  await db.bare.create({ data: { title: 'a' } })
  await db.soft.create({ data: { title: 'a' } })
  await db.parent.create({ data: { name: 'p' } })
  // Three children, so a cascade that leaked into the count could not be
  // mistaken for the one parent row the delete named.
  await db.child.createMany({ data: [{ parentId: 1 }, { parentId: 1 }, { parentId: 1 }] })
})

describe('bulk count = rows of this model (FJS-320)', () => {
  test('updateMany on an @@fts model', async () => {
    expect(await db.doc.updateMany({ where: {}, data: { title: 'b' } })).toEqual({ count: 1 })
  })

  test('updateMany on a model with an updatedAt trigger', async () => {
    expect(await db.note.updateMany({ where: {}, data: { title: 'b' } })).toEqual({ count: 1 })
  })

  test('updateMany with no trigger at all', async () => {
    expect(await db.bare.updateMany({ where: {}, data: { title: 'b' } })).toEqual({ count: 1 })
  })

  test('removeMany (soft) counts the rows it stamped', async () => {
    expect(await db.soft.removeMany({ where: {} })).toEqual({ count: 1 })
  })

  test('removeMany (hard) on an @@fts model', async () => {
    expect(await db.doc.removeMany({ where: {} })).toEqual({ count: 1 })
  })

  test('deleteMany does not count cascaded children', async () => {
    expect(await db.parent.deleteMany({ where: {} })).toEqual({ count: 1 })
    expect(await db.child.count()).toBe(0)
  })

  test('a write that matched nothing still answers 0', async () => {
    expect(await db.doc.updateMany({ where: { title: 'nope' }, data: { title: 'b' } })).toEqual({ count: 0 })
    expect(await db.doc.deleteMany({ where: { title: 'nope' } })).toEqual({ count: 0 })
  })

  test('the count survives an open transaction', async () => {
    await db.$transaction(async (tx: any) => {
      expect(await tx.doc.updateMany({ where: {}, data: { title: 'b' } })).toEqual({ count: 1 })
    })
  })

  test('announce: rows and the default count agree', async () => {
    const loud = await createClient({ db: ':memory:', schema: SCHEMA, announce: 'rows' })
    await loud.doc.createMany({ data: [{ title: 'a', body: 'one' }, { title: 'b', body: 'two' }] })
    expect(await loud.doc.updateMany({ where: {}, data: { body: 'x' } })).toEqual({ count: 2 })
  })
})
