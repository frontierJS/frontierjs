// test/create-many-select.test.ts
//
// `createMany({ data, select })` answers `{ count, rows }` (FJS-D2298): a bulk
// load that writes child rows needs each new id, and without `select` it read
// every batch back with a second query (FJS-4155). `rows` is graded by the
// caller's read rules, so a row the policy hides is written and counted but
// not handed back.

import { describe, test, expect } from 'bun:test'
import { createClient } from '../src/index.js'

const SCHEMA = `
  model Track {
    id     Int     @id @default(autoincrement())
    path   String
    title  String
    secret Boolean @default(false)
    @@allow(create, true)
    @@allow(read, !secret)
  }

  model Note {
    id    Int    @id @default(autoincrement())
    title String
    body  String
    @@allow(all, true)
  }
`

const client = () => createClient({ schema: SCHEMA, db: ':memory:' })

describe('createMany select', () => {
  test('answers the new rows, in insert order, shaped by select', async () => {
    const db = await client()
    const out = await db.note.createMany({ data: [{ title: 'a', body: 'x' }, { title: 'b', body: 'y' }], select: { id: true, title: true } })
    expect(out).toEqual({ count: 2, rows: [{ id: 1, title: 'a' }, { id: 2, title: 'b' }] })
  })

  test('without select the answer stays { count }', async () => {
    const db = await client()
    const out = await db.note.createMany({ data: [{ title: 'a', body: 'x' }] })
    expect(out).toEqual({ count: 1 })
  })

  test('a row the read policy hides is counted and not handed back', async () => {
    const db = await client()
    const out = await db.track.createMany({
      data: [{ path: '/a', title: 'A' }, { path: '/b', title: 'B', secret: true }, { path: '/c', title: 'C' }],
      select: { id: true, path: true },
    })
    expect(out).toEqual({ count: 3, rows: [{ id: 1, path: '/a' }, { id: 3, path: '/c' }] })
    expect(await db.asSystem().track.count()).toBe(3)
  })

  test('inside a transaction the ids name rows the child writes can use', async () => {
    const db = await client()
    const ids = await db.$transaction(async (tx: any) => {
      const { rows } = await tx.note.createMany({ data: [{ title: 'a', body: 'x' }, { title: 'b', body: 'y' }], select: { id: true } })
      return rows.map((r: any) => r.id)
    })
    expect(ids).toEqual([1, 2])
  })

  test('select: false is refused, since the bulk answer is { count } without it', async () => {
    const db = await client()
    await expect(db.note.createMany({ data: [{ title: 'a', body: 'x' }], select: false as any })).rejects.toThrow(/must be an object or a list naming columns/)
  })

  test('an unknown column in select is refused by name before the write', async () => {
    const db = await client()
    await expect(db.note.createMany({ data: [{ title: 'a', body: 'x' }], select: { nope: true } as any })).rejects.toThrow(/nope/)
    expect(await db.note.count()).toBe(0)
  })
})
