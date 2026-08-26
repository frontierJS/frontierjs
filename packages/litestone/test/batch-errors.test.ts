// test/batch-errors.test.ts
//
// WHICH row of a batch failed. A bulk write throws SQLite's own message, which
// names the column and never the row — `UNIQUE constraint failed: post.slug`
// against a 500-row import left bisecting the batch by hand as the only way to
// find it (FJS-207). The loop already knew the index.
//
// The index is reported as `data[i]`, the subscript the caller can go and look
// at, and it is on the error as `batchIndex`/`batchSize` so a service can act
// on it rather than parse prose. The error's CLASS is kept — it carries the
// status and `retryable` past the API boundary, and a wrapper would flatten
// SoftDeletedUniqueError's 409 into an unclassified 500.

import { describe, test, expect, beforeEach } from 'bun:test'
import { createClient } from '../src/index.js'

const SCHEMA = `
  model Post {
    id    Int    @id @default(autoincrement())
    slug  String @unique
    title String
  }

  model Soft {
    id        Int       @id @default(autoincrement())
    code      String    @unique
    deletedAt DateTime?
    @@softDelete
  }
`

let db: any

beforeEach(async () => {
  db = await createClient({ db: ':memory:', schema: SCHEMA })
})

const thrown = (p: Promise<unknown>) => p.then(() => null, (e: any) => e)

describe('a failing batch names its row (FJS-207)', () => {
  test('createMany: a unique conflict names the index and the values', async () => {
    const err = await thrown(db.post.createMany({ data: [
      { slug: 'a', title: 'A' },
      { slug: 'b', title: 'B' },
      { slug: 'a', title: 'again' },
    ] }))
    expect(err.batchIndex).toBe(2)
    expect(err.batchSize).toBe(3)
    expect(err.message).toContain('data[2] of 3')
    // The translated conflict names the value itself, so the annotation no
    // longer restates it — one sentence, said once (FJS-441).
    expect(err.message).toContain('slug "a" is already taken')
    // What is NOT kept is SQLite's own sentence: the physical table name is not
    // the name the caller used, and the class carries which constraint fired
    // where the wording used to (FJS-441).
    expect(err.name).toBe('UniqueConflictError')
    expect(err.status).toBe(409)
    expect(err.fields).toEqual(['slug'])
    expect(err.message).not.toContain('post.slug')
  })

  test('the batch rolled back, and the message says so', async () => {
    const err = await thrown(db.post.createMany({ data: [
      { slug: 'a', title: 'A' }, { slug: 'a', title: 'again' },
    ] }))
    expect(err.message).toContain('nothing in the batch was written')
    expect(await db.post.count()).toBe(0)
  })

  test('createMany: a validation failure names the row too', async () => {
    // Thrown before any statement runs — the row-building map is where a
    // required field goes missing, and it had no index either.
    const err = await thrown(db.post.createMany({ data: [
      { slug: 'x', title: 'X' }, { slug: 'y' },
    ] }))
    expect(err.name).toBe('ValidationError')
    expect(err.batchIndex).toBe(1)
    expect(err.message).toContain('data[1] of 2')
  })

  test('the error class survives, so the status does', async () => {
    await db.soft.create({ data: { code: 'c1' } })
    await db.soft.removeMany({ where: {} })
    const err = await thrown(db.soft.createMany({ data: [
      { code: 'c2' }, { code: 'c1' },
    ] }))
    expect(err.name).toBe('SoftDeletedUniqueError')
    expect(err.status).toBe(409)
    expect(err.batchIndex).toBe(1)
    // The model name is not said twice, once by each half of the message.
    expect(err.message.match(/Soft:/g)).toHaveLength(1)
  })

  test('upsertMany: a conflict that is NOT the conflict target', async () => {
    // ON CONFLICT resolves the target; a second @unique still reaches SQLite,
    // and that loop carried no try/catch at all.
    const err = await thrown(db.post.upsertMany({
      data: [{ id: 10, slug: 'q', title: 'Q' }, { id: 11, slug: 'q', title: 'R' }],
      conflictTarget: ['id'],
    }))
    expect(err.batchIndex).toBe(1)
    expect(err.message).toContain('data[1] of 2')
    expect(err.message).toContain('slug "q" is already taken')
  })

  test('a single-row write is not annotated', async () => {
    await db.post.create({ data: { slug: 'solo', title: 'S' } })
    const err = await thrown(db.post.create({ data: { slug: 'solo', title: 'dup' } }))
    expect(err.batchIndex).toBeUndefined()
    expect(err.message).not.toContain('data[')
  })
})
