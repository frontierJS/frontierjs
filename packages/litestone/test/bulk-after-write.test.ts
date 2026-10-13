// bulk-after-write.test.ts — a bulk write is heard by `onAfterWrite` once per
// row it wrote, as `create`/`update`/`delete` already are (`FJS-D588`).
//
// A copy derived from other rows (a grant inherited down a self-relation) kept
// by a plugin went stale and failed OPEN: `createMany` and `updateMany` reached
// no hook, so the copy never heard 40 created and 374 moved rows (FJS-1725).

import { describe, test, expect } from 'bun:test'
import { createClient, autoMigrate } from '../src/index.js'
import { Plugin } from '../src/core/plugin.js'

const SCHEMA = `
  database main { path ":memory:" }
  model Page {
    id       Int      @id
    parentId Int?
    title    String
    archived Boolean  @default(false)
  }
`

class Writes extends Plugin {
  written: Array<[string, string, any]> = []
  async onAfterWrite(model: string, op: string, row: any) { this.written.push([model, op, row]) }
}

async function client(plugin: Plugin) {
  const db: any = await createClient({ schema: SCHEMA, db: ':memory:', plugins: [plugin] })
  await autoMigrate(db)
  return db
}

describe('onAfterWrite hears a bulk write row by row (FJS-1725)', () => {
  test('createMany — one create per row, each the row as read', async () => {
    const w = new Writes()
    const db = await client(w)
    await db.page.createMany({ data: [{ id: 1, title: 'a' }, { id: 2, parentId: 1, title: 'b' }] })
    expect(w.written.map(([m, op, r]) => [m, op, r?.id])).toEqual([['Page', 'create', 1], ['Page', 'create', 2]])
    expect(w.written[1][2]).toMatchObject({ parentId: 1, title: 'b', archived: false })
    db.$close()
  })

  test('updateMany — one update per row reached, each the row after the write', async () => {
    const w = new Writes()
    const db = await client(w)
    await db.page.createMany({ data: [{ id: 1, title: 'a' }, { id: 2, parentId: 1, title: 'b' }, { id: 3, parentId: 1, title: 'c' }] })
    w.written.length = 0
    const { count } = await db.page.updateMany({ where: { parentId: 1 }, data: { parentId: null, archived: true } })
    expect(count).toBe(2)
    expect(w.written.map(([, op, r]) => [op, r?.id]).sort()).toEqual([['update', 2], ['update', 3]])
    for (const [, , r] of w.written) expect(r).toMatchObject({ parentId: null, archived: true })
    db.$close()
  })

  test('a bulk write that reaches no row is not heard', async () => {
    const w = new Writes()
    const db = await client(w)
    await db.page.updateMany({ where: { id: 99 }, data: { title: 'x' } })
    await db.page.createMany({ data: [] })
    expect(w.written).toEqual([])
    db.$close()
  })

  test('the bulk answer is still the count', async () => {
    const db = await client(new Writes())
    expect(await db.page.createMany({ data: [{ id: 1, title: 'a' }] })).toEqual({ count: 1 })
    db.$close()
  })
})
