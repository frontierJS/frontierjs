// An argument a verb does not read is refused by name (FJS-1310).
//
// A typo INSIDE `where` was refused (FJS-634), but a key BESIDE it was never
// looked at, so `deleteMany({ wher: { id: 1 } })` deleted every row the caller
// could reach and answered the count as success. The same drop made
// `findMany({ search })` and `query({ search })` answer every row as the hits,
// which is a search box that looks like it works.
//
// Each refusal sits beside a control that proves the rows are still there and
// the correctly spelled call still answers — a fix that refused everything
// would satisfy the refusals alone.

import { describe, it, expect } from 'bun:test'
import { createClient } from '../src/index.js'

const ROOT = new URL('..', import.meta.url).pathname

const SCHEMA = `
database main { path ":memory:" }
model Note { id Int @id @default(autoincrement())  body String  n Int @default(0)
             @@fts([body]) }
`

async function seeded() {
  const db = await createClient({ schema: SCHEMA, resolveFrom: ROOT })
  for (const body of ['tachyon drive', 'warp core', 'deflector dish']) await db.note.create({ data: { body } })
  return db
}

describe('an unknown argument is refused, not dropped', () => {
  it('deleteMany({ wher }) refuses and deletes nothing', async () => {
    const db = await seeded()
    await expect(db.note.deleteMany({ wher: { id: 1 } } as any))
      .rejects.toThrow(/Unknown argument 'wher' to Note\.deleteMany.*Did you mean: where\?/)
    expect(await db.note.count()).toBe(3)
    expect((await db.note.deleteMany({ where: { id: 1 } })).count).toBe(1)
    expect(await db.note.count()).toBe(2)
  })

  it('refuses under asSystem() the same as under the root client', async () => {
    const db = await seeded()
    await expect(db.asSystem().note.deleteMany({ wher: { id: 1 } } as any)).rejects.toThrow(/Unknown argument 'wher'/)
    expect(await db.note.count()).toBe(3)
  })

  it('updateMany({ wher }) refuses and rewrites nothing', async () => {
    const db = await seeded()
    await expect(db.note.updateMany({ wher: { id: 1 }, data: { n: 9 } } as any)).rejects.toThrow(/Unknown argument 'wher'/)
    expect(await db.note.count({ where: { n: 9 } })).toBe(0)
  })

  it('findMany, findFirst and count refuse rather than answer unfiltered', async () => {
    const db = await seeded()
    for (const verb of ['findMany', 'findFirst', 'count'] as const)
      await expect((db.note as any)[verb]({ wher: { id: 1 } })).rejects.toThrow(new RegExp(`Unknown argument 'wher' to Note\\.${verb}`))
    expect(await db.note.findMany({ where: { id: 1 } })).toHaveLength(1)
  })

  it('a search key on a read points at the search verb', async () => {
    const db = await seeded()
    for (const key of ['search', '$search'])
      await expect(db.note.findMany({ [key]: 'tachyon' } as any)).rejects.toThrow(/its own verb: Note\.search/)
    await expect(db.note.query({ search: 'tachyon' } as any)).rejects.toThrow(/Unknown argument 'search'/)
    expect(await db.note.search('tachyon')).toHaveLength(1)
  })

  it('create refuses a key it does not read', async () => {
    const db = await seeded()
    await expect(db.note.create({ data: { body: 'x' }, retrun: true } as any)).rejects.toThrow(/Unknown argument 'retrun' to Note\.create/)
    expect(await db.note.count()).toBe(3)
  })

  it('a named aggregate is a key the caller coins and is still accepted', async () => {
    const db = await seeded()
    const out: any = await db.note.aggregate({ _total: { count: true } } as any)
    expect(out._total).toBe(3)
    await expect(db.note.aggregate({ _count: true, wher: {} } as any)).rejects.toThrow(/Unknown argument 'wher'/)
  })

  it('a page\'s own arguments are accepted by count', async () => {
    const db = await seeded()
    const page = { where: { n: 0 }, orderBy: { id: 'asc' as const }, limit: 1 }
    expect(await db.note.findMany(page)).toHaveLength(1)
    expect(await db.note.count(page)).toBe(3)
  })
})
