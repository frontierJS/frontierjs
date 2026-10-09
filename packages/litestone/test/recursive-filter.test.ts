// test/recursive-filter.test.ts
//
// FJS-2010: findMany({ recursive }) walked THROUGH a row the global filter or a
// plugin's read filter hides. Every row returned was visible, but a visible
// descendant was reached by a hidden path, and `nested` placed it at a depth
// that named the hidden row. A hidden row hides its whole subtree, as a row
// policy and a soft delete already do (the walk carries the anchor's predicate).
import { describe, test, expect } from 'bun:test'
import { createClient, Plugin } from '../src/index.js'

const SCHEMA = `
  model Node {
    id       Int    @id
    tenant   String
    parentId Int?
    parent   Node?  @relation("tree", fields: [parentId], references: [id])
    children Node[] @relation("tree")
  }
`
// 1(a) → 3(b) → 5(a);  1(a) → 2(a);  4(b) is a hidden root
const ROWS = [
  { id: 1, tenant: 'a', parentId: null },
  { id: 2, tenant: 'a', parentId: 1 },
  { id: 3, tenant: 'b', parentId: 1 },
  { id: 4, tenant: 'b', parentId: null },
  { id: 5, tenant: 'a', parentId: 3 },
]

class TenantA extends Plugin {
  buildReadFilter(model: string) { return model === 'Node' ? { tenant: 'a' } : null }
}

async function seeded(opts: Record<string, unknown>) {
  const db: any = await createClient({ db: ':memory:', schema: SCHEMA, ...opts })
  for (const data of ROWS) await db.asSystem().node.create({ data })
  return db
}

const FIXTURES: Record<string, Record<string, unknown>> = {
  'global filter': { filters: { node: { tenant: 'a' } } },
  'plugin read filter': { plugins: [new TenantA()] },
}

for (const [name, opts] of Object.entries(FIXTURES)) {
  describe(`recursive × ${name}`, () => {
    test('the control: findMany answers only the visible rows', async () => {
      const db = await seeded(opts)
      expect((await db.node.findMany({ orderBy: { id: 'asc' } })).map((r: any) => r.id)).toEqual([1, 2, 5])
      db.$close()
    })

    test('a hidden row ends the walk: its visible descendant is not reached', async () => {
      const db = await seeded(opts)
      const rows = await db.node.findMany({ where: { id: 1 }, recursive: true, orderBy: { id: 'asc' } })
      expect(rows.map((r: any) => r.id)).toEqual([2])
      db.$close()
    })

    test('nested never places a row at a depth that crosses a hidden one', async () => {
      const db = await seeded(opts)
      const rows = await db.node.findMany({ where: { id: 1 }, recursive: { nested: true }, orderBy: { id: 'asc' } })
      expect(rows.map((r: any) => [r.id, r._depth])).toEqual([[2, 1]])
      db.$close()
    })

    test('a hidden anchor is not walked', async () => {
      const db = await seeded(opts)
      expect(await db.node.findMany({ where: { id: 3 }, recursive: true })).toEqual([])
      db.$close()
    })
  })
}
