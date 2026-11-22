/**
 * test/monotonic.test.ts — `@monotonic` (`FJS-D1291`, `FJS-3052`).
 *
 * A column that may move one way: a resume offset a replayed chunk never moves
 * backwards. The compare rides the UPDATE's own WHERE, so two chunks racing
 * cannot both pass a read-then-write check, and a write that would move it the
 * wrong way is refused by name (`MonotonicError`, 409) rather than dropped.
 * Equal is legal, so the same chunk sent twice is idempotent. Like `@immutable`
 * it is the constraint tier: `asSystem()` does not drop it.
 */

import { describe, test, expect } from 'bun:test'
import { parse, createClient, MonotonicError } from '../src/index.js'

const SCHEMA = `
database main { path ":memory:" }
model Upload {
  id       Int       @id @default(autoincrement())
  received Int       @default(0) @monotonic
  size     Int?      @monotonic
  seenAt   DateTime? @monotonic
  budget   Int       @default(100) @monotonic(down)
  note     String?
}
`
const client = () => createClient({ schema: SCHEMA, resolveFrom: import.meta.dir })
const errsOf = (src: string) => parse(src).errors.join(' · ')

async function refusal(p: Promise<unknown>) {
  try { await p } catch (e) { return e as any }
  throw new Error('expected the write to be refused')
}

describe('what parses', () => {
  test('Int, Int @big and DateTime take it, and (down) is its one argument', () => {
    expect(parse(`model D { id Int @id  n Int @monotonic }`).valid).toBe(true)
    expect(parse(`model D { id Int @id  n Int @big @monotonic }`).valid).toBe(true)
    expect(parse(`model D { id Int @id  n DateTime? @monotonic }`).valid).toBe(true)
    expect(parse(`model D { id Int @id  n Int @monotonic(down) }`).valid).toBe(true)
    expect(errsOf(`model D { id Int @id  n Int @monotonic(sideways) }`)).toMatch(/down/)
  })

  test('a type with no order a write can be held to is refused', () => {
    expect(errsOf(`model D { id Int @id  n String @monotonic }`)).toMatch(/@monotonic/)
    expect(errsOf(`model D { id Int @id  n Boolean @monotonic }`)).toMatch(/@monotonic/)
  })

  test('it is refused beside the words that already own the column\'s direction', () => {
    expect(errsOf(`model D { id Int @id  n Int @monotonic @immutable }`)).toMatch(/@immutable/)
    expect(errsOf(`model D { id Int @id  v Int @version @monotonic }`)).toMatch(/@version/)
  })
})

describe('the write half', () => {
  test('forward and equal land; backwards is refused by name and the row keeps its value', async () => {
    const db = await client()
    const u  = await db.upload.create({ data: {} })
    expect((await db.upload.update({ where: { id: u.id }, data: { received: 512 } })).received).toBe(512)
    // The same chunk replayed: equal is not backwards.
    expect((await db.upload.update({ where: { id: u.id }, data: { received: 512 } })).received).toBe(512)
    const e = await refusal(db.upload.update({ where: { id: u.id }, data: { received: 256, note: 'stale' } }))
    expect(e).toBeInstanceOf(MonotonicError)
    expect(e.status).toBe(409)
    expect(e.retryable).toBe(false)
    expect(e.data).toMatchObject({ model: 'Upload', field: 'received', direction: 'up' })
    const row = await db.upload.findUnique({ where: { id: u.id } })
    expect(row.received).toBe(512)
    expect(row.note).toBeNull()
  })

  test('asSystem() is refused the same way', async () => {
    const db = await client()
    const u  = await db.upload.create({ data: { received: 10 } })
    await expect(db.asSystem().upload.update({ where: { id: u.id }, data: { received: 9 } }))
      .rejects.toBeInstanceOf(MonotonicError)
  })

  test('an atomic operator is held to the same direction', async () => {
    const db = await client()
    const u  = await db.upload.create({ data: { received: 10 } })
    expect((await db.upload.update({ where: { id: u.id }, data: { received: { increment: 5 } } })).received).toBe(15)
    await expect(db.upload.update({ where: { id: u.id }, data: { received: { decrement: 1 } } }))
      .rejects.toBeInstanceOf(MonotonicError)
  })

  test('a NULL column takes any first value, and a value is never cleared back to NULL', async () => {
    const db = await client()
    const u  = await db.upload.create({ data: {} })
    expect((await db.upload.update({ where: { id: u.id }, data: { size: 4096 } })).size).toBe(4096)
    await expect(db.upload.update({ where: { id: u.id }, data: { size: null } }))
      .rejects.toBeInstanceOf(MonotonicError)
  })

  test('(down) only lowers', async () => {
    const db = await client()
    const u  = await db.upload.create({ data: {} })
    expect((await db.upload.update({ where: { id: u.id }, data: { budget: 40 } })).budget).toBe(40)
    await expect(db.upload.update({ where: { id: u.id }, data: { budget: 41 } }))
      .rejects.toBeInstanceOf(MonotonicError)
  })

  test('a DateTime compares as an instant', async () => {
    const db = await client()
    const u  = await db.upload.create({ data: { seenAt: new Date('2026-01-02T00:00:00Z') } })
    await db.upload.update({ where: { id: u.id }, data: { seenAt: new Date('2026-01-03T00:00:00Z') } })
    await expect(db.upload.update({ where: { id: u.id }, data: { seenAt: new Date('2026-01-01T00:00:00Z') } }))
      .rejects.toBeInstanceOf(MonotonicError)
  })

  test('a where that reaches no row still answers null, not a refusal', async () => {
    const db = await client()
    expect(await db.upload.update({ where: { id: 999 }, data: { received: 1 } })).toBeNull()
  })

  test('updateMany refuses the whole batch when one row would move backwards', async () => {
    const db = await client()
    const a  = await db.upload.create({ data: { received: 5 } })
    const b  = await db.upload.create({ data: { received: 50 } })
    await expect(db.upload.updateMany({ where: {}, data: { received: 20 } }))
      .rejects.toBeInstanceOf(MonotonicError)
    expect((await db.upload.findUnique({ where: { id: a.id } })).received).toBe(5)
    expect((await db.upload.findUnique({ where: { id: b.id } })).received).toBe(50)
    expect(await db.upload.updateMany({ where: { id: a.id }, data: { received: 20 } })).toEqual({ count: 1 })
  })

  test('upsert\'s update branch is held to it', async () => {
    const db = await client()
    const u  = await db.upload.create({ data: { received: 30 } })
    await expect(db.upload.upsert({ where: { id: u.id }, create: {}, update: { received: 3 } }))
      .rejects.toBeInstanceOf(MonotonicError)
    expect((await db.upload.findUnique({ where: { id: u.id } })).received).toBe(30)
  })
})

describe('upsertMany', () => {
  test('naming the column in its conflict half is refused by name, since DO UPDATE … WHERE would skip the row', async () => {
    const db = await client()
    await expect(db.upload.upsertMany({ data: [{ id: 1, received: 3 }] })).rejects.toThrow(/@monotonic/)
    expect(await db.upload.upsertMany({ data: [{ id: 1, note: 'x' }], update: ['note'] })).toMatchObject({ count: 1 })
  })
})
