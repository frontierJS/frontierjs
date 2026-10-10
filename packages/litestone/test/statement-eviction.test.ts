// test/statement-eviction.test.ts
// The fast paths keep working after the statement cache evicts their SQL.
// wrapDb's LRU finalizes what it evicts, and the findUnique-by-pk and
// findMany({}) fast paths held the statement they prepared at table build, so
// once 500 other shapes had run every pk lookup threw 'Statement has
// finalized' until the process restarted.
//
// Traps in this file:
//   • A varied IN-list length is the realistic churn: each length is its own
//     SQL string, so 600 lengths are 600 cache entries.
//   • The findMany({}) fast path exists only on a @@softDelete model, so the
//     schema carries one.

import { describe, it, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '../src/index.js'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

const SCHEMA = `
model Post {
  id    Int    @id
  title String
}

model Draft {
  id        Int       @id
  title     String
  deletedAt DateTime?
  @@softDelete
}
`

async function churn(db: any) {
  for (let n = 1; n <= 600; n++)
    await db.post.findMany({ where: { id: Array.from({ length: n }, (_, k) => k) } })
}

for (const where of [':memory:', 'file']) {
  describe(`the fast paths survive statement eviction (${where})`, () => {
    async function open() {
      if (where === ':memory:') return createClient({ schema: SCHEMA, db: ':memory:' })
      const dir = mkdtempSync(join(tmpdir(), 'ls-evict-'))
      dirs.push(dir)
      return createClient({ schema: SCHEMA, db: join(dir, 'app.db') })
    }

    it('findUnique by primary key', async () => {
      const db = await open()
      await db.post.create({ data: { id: 1, title: 'a' } })
      await churn(db)
      expect((await db.post.findUnique({ where: { id: 1 } }))?.title).toBe('a')
      await db.$close()
    })

    it('findMany({}) on a soft-delete model', async () => {
      const db = await open()
      await db.draft.create({ data: { id: 1, title: 'a' } })
      await db.draft.findMany({})
      await churn(db)
      expect((await db.draft.findMany({})).map((r: any) => r.id)).toEqual([1])
      await db.$close()
    })
  })
}
