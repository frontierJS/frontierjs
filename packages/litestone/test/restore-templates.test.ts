// test/restore-templates.test.ts
//
// `restore` takes no template flag and needs none: READ_RULES leaves the
// templates rule out of it (`NOT_RESTORE`), so a removed @@hasTemplates row
// comes back by id or by a where that matches it, even through `asSystem()`.
// `FJS-2625` claimed the opposite; folding the rule in would be what made a
// removed template unrestorable.

import { describe, expect, test } from 'bun:test'
import { createClient } from '../src/index.js'

const SCHEMA = `
  database main { path ":memory:" }

  model Task {
    id         Int      @id
    title      String
    isTemplate Boolean  @default(false)
    deletedAt  DateTime?
    @@db(main)
    @@softDelete
    @@hasTemplates
  }
`

async function seeded() {
  const db: any = await createClient({ databases: ':memory:', schema: SCHEMA })
  const sys = db.asSystem()
  await sys.task.create({ data: { id: 1, title: 'template', isTemplate: true } })
  await sys.task.create({ data: { id: 2, title: 'record' } })
  await sys.task.removeMany({ where: {}, withTemplates: true })
  return sys
}

const live = async (sys: any) =>
  (await sys.task.findMany({ withTemplates: true, orderBy: { id: 'asc' } })).map((r: any) => r.id)

describe('FJS-2625 — a removed template is restorable', () => {
  test('both rows are gone before the restore', async () => {
    expect(await live(await seeded())).toEqual([])
  })

  test('a template comes back by id', async () => {
    const sys = await seeded()
    const back = await sys.task.restore({ where: { id: 1 } })
    expect(back.map((r: any) => r.id)).toEqual([1])
    expect(back[0].isTemplate).toBe(true)
    expect(await live(sys)).toEqual([1])
  })

  test('a where matching both restores both', async () => {
    const sys = await seeded()
    const back = await sys.task.restore({ where: {} })
    expect(back.map((r: any) => r.id).sort()).toEqual([1, 2])
  })
})
