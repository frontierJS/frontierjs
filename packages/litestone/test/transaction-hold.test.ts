// `$hold({ commit, rollback })` on a client: the effect outside the database
// that a transaction body started, finished when the outermost transaction
// commits and undone when the frame it was held in rolls back (`FJS-D1873`,
// `FJS-D2296`). An app whose record of truth is outside the database (anvil's
// issues as git refs, `FJS-4364`) prepares the outside write inside the body
// and holds its commit and its abort here.
//
// A held side that throws or rejects is logged by name. It is never thrown to
// the caller: on commit the rows are already durable, and on rollback the
// body's own error is the one the caller is owed.

import { describe, test, expect, spyOn, afterEach } from 'bun:test'
import { createClient } from '../src/core/client.js'

const SCHEMA = `
model Issue {
  id    Int    @id @default(autoincrement())
  title String
  @@gate(0)
}
`

const open = () => createClient({ schema: SCHEMA, db: ':memory:' })

let warn: ReturnType<typeof spyOn> | null = null
afterEach(() => { warn?.mockRestore(); warn = null })

describe('$hold on a $transaction callback (FJS-4364)', () => {
  test('commit runs after COMMIT, and sees the row on the root client', async () => {
    const db = await open()
    const seen: unknown[] = []
    await db.$transaction(async (tx: any) => {
      await tx.issue.create({ data: { title: 'a' } })
      tx.$hold({ commit: async () => { seen.push(await db.issue.count()) }, rollback: () => seen.push('rollback') })
      expect(seen).toEqual([])
    })
    expect(seen).toEqual([1])
  })

  test('rollback runs when the body throws, and the body error is what the caller gets', async () => {
    const db = await open()
    const seen: string[] = []
    const err = await db.$transaction(async (tx: any) => {
      await tx.issue.create({ data: { title: 'a' } })
      tx.$hold({ commit: () => seen.push('commit'), rollback: () => seen.push('rollback') })
      throw new Error('ref would not move')
    }).catch((e: Error) => e)
    expect((err as Error).message).toBe('ref would not move')
    expect(seen).toEqual(['rollback'])
    expect(await db.issue.count()).toBe(0)
  })

  test('a held side in a rolled-back savepoint is undone, the outer one still commits', async () => {
    const db = await open()
    const seen: string[] = []
    await db.$transaction(async (tx: any) => {
      tx.$hold({ commit: () => seen.push('outer commit'), rollback: () => seen.push('outer rollback') })
      await tx.$transaction(async (inner: any) => {
        inner.$hold({ commit: () => seen.push('inner commit'), rollback: () => seen.push('inner rollback') })
        throw new Error('inner')
      }).catch(() => {})
    })
    expect(seen).toEqual(['inner rollback', 'outer commit'])
  })

  test('outside a transaction the write is already real, so commit runs now', async () => {
    const db = await open()
    const seen: string[] = []
    db.$hold({ commit: () => seen.push('commit'), rollback: () => seen.push('rollback') })
    expect(seen).toEqual(['commit'])
  })

  test('every flavor holds: asSystem, $setAuth', async () => {
    const db = await open()
    const seen: string[] = []
    await db.asSystem().$transaction(async (tx: any) => { tx.$hold({ commit: () => seen.push('system') }) })
    await db.$setAuth({ id: 1 }).$transaction(async (tx: any) => { tx.$hold({ commit: () => seen.push('auth') }) })
    expect(seen).toEqual(['system', 'auth'])
  })

  test('a rejected commit side is logged by name, and the committed write still resolves', async () => {
    warn = spyOn(console, 'error').mockImplementation(() => {})
    const db = await open()
    const out = await db.$transaction(async (tx: any) => {
      await tx.issue.create({ data: { title: 'a' } })
      tx.$hold({ name: 'anvil ref', commit: () => Promise.reject(new Error('update-ref commit failed')) })
      return 'landed'
    })
    expect(out).toBe('landed')
    expect(await db.issue.count()).toBe(1)
    const said = warn.mock.calls.map(c => String(c[0])).join('\n')
    expect(said).toContain(`'anvil ref'`)
    expect(said).toContain('commit')
    expect(said).toContain('update-ref commit failed')
  })

  test('a throwing rollback side is logged by name, and the body error still reaches the caller', async () => {
    warn = spyOn(console, 'error').mockImplementation(() => {})
    const db = await open()
    const err = await db.$transaction(async (tx: any) => {
      tx.$hold({ name: 'anvil ref', rollback: () => { throw new Error('update-ref abort failed') } })
      throw new Error('body')
    }).catch((e: Error) => e)
    expect((err as Error).message).toBe('body')
    const said = warn.mock.calls.map(c => String(c[0])).join('\n')
    expect(said).toContain(`'anvil ref'`)
    expect(said).toContain('rollback')
    expect(said).toContain('update-ref abort failed')
  })
})
