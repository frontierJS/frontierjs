/**
 * test/made-at.test.ts — `db.$madeAt(fn)`, when the write in progress was made
 * (`FJS-D469`, `FJS-1278`).
 *
 * A write held on a device and sent hours later was made then. The realm that
 * has a request installs a closure answering that instant, and `@default(now())`
 * and `@updatedAt` stamp it in place of the clock; a predicate's `now()` and the
 * audit trail stay on the landing time.
 */

import { describe, test, expect } from 'bun:test'
import { createClient } from '../src/index.js'

const SCHEMA = `
  model Note {
    id        Int      @id @default(autoincrement())
    body      String
    createdAt DateTime @default(now())
    updatedAt DateTime @updatedAt
  }
`

const MADE = '2026-09-22T09:46:00.000Z'
const LAND = '2026-09-22T17:46:00.000Z'

describe('db.$madeAt', () => {
  test('stamps `@default(now())` and `@updatedAt` on a create', async () => {
    const db: any = await createClient({ db: ':memory:', schema: SCHEMA, now: () => LAND })
    let made: string | null = MADE
    db.$madeAt(() => made)
    const row = await db.asSystem().note.create({ data: { body: 'in' } })
    expect(row.createdAt).toBe(MADE)
    expect(row.updatedAt).toBe(MADE)
    made = null
    const later = await db.asSystem().note.create({ data: { body: 'live' } })
    expect(later.createdAt).toBe(LAND)
    db.$close()
  })

  test('stamps `@updatedAt` on an update', async () => {
    const db: any = await createClient({ db: ':memory:', schema: SCHEMA, now: () => LAND })
    const sys = db.asSystem()
    const row = await sys.note.create({ data: { body: 'in' } })
    const restore = db.$madeAt(() => MADE)
    const updated = await sys.note.update({ where: { id: row.id }, data: { body: 'out' } })
    expect(updated.updatedAt).toBe(MADE)
    expect(updated.createdAt).toBe(LAND)
    restore()
    const again = await sys.note.update({ where: { id: row.id }, data: { body: 'again' } })
    expect(again.updatedAt).toBe(LAND)
    db.$close()
  })

  test('reaches a client scoped before it was installed', async () => {
    const db: any = await createClient({ db: ':memory:', schema: SCHEMA, now: () => LAND })
    const sys = db.asSystem()
    db.$madeAt(() => MADE)
    expect((await sys.note.create({ data: { body: 'in' } })).createdAt).toBe(MADE)
    db.$close()
  })

  test('refuses something that is not a function, by name', async () => {
    const db: any = await createClient({ db: ':memory:', schema: SCHEMA })
    expect(() => db.$madeAt(MADE)).toThrow('$madeAt(fn)')
    db.$close()
  })
})
