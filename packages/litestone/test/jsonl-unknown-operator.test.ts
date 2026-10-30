// jsonl-unknown-operator.test.ts — a jsonl `where` refuses what it cannot answer.
//
// `matchCondition` skipped an operator it did not know and `matchWhere` read
// `$raw` as a column named `$raw`, so a trail or jsonl model answered the
// unfiltered set where a SQLite model refuses by name (`FJS-2298`).

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createClient, sql } from '../src/index.js'

const tick = () => new Promise((r) => setImmediate(r))

async function withTrail(fn: (sys: any) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'fjs-jsonl-op-'))
  try {
    const db: any = await createClient({ resolveFrom: dir, schema: `
      database main  { path "${dir}/main.db" }
      database audit { path "${dir}/audit/" driver trail }
      model Thing { id Int @id  name String  @@trail(audit) }
    ` })
    const sys = db.asSystem()
    await sys.thing.create({ data: { id: 1, name: 'a' } })
    await sys.thing.create({ data: { id: 2, name: 'b' } })
    await tick(); await tick()
    try { await fn(sys) } finally { db.$close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

describe('a jsonl where refuses an operator it does not know', () => {
  test('$raw at the top level, nested, and on a column is refused by name', async () => {
    await withTrail(async (sys) => {
      const raw = sql`1 = 0`
      await expect(sys.auditTrail.findMany({ where: { $raw: raw } })).rejects.toThrow(/\$raw/)
      await expect(sys.auditTrail.findMany({ where: { NOT: { $raw: raw } } })).rejects.toThrow(/\$raw/)
      await expect(sys.auditTrail.findMany({ where: { OR: [{ model: 'Thing' }, { $raw: raw }] } })).rejects.toThrow(/\$raw/)
      await expect(sys.auditTrail.findMany({ where: { records: { $raw: raw } } })).rejects.toThrow(/\$raw/)
      await expect(sys.auditTrail.count({ where: { $raw: raw } })).rejects.toThrow(/\$raw/)
    })
  })

  test('a misspelt operator is refused and the valid list is named', async () => {
    await withTrail(async (sys) => {
      await expect(sys.auditTrail.findMany({ where: { operation: { nope: 'create' } } })).rejects.toThrow(/Unknown where operator "nope".*one of:/)
    })
  })

  test('a bare array is membership, as on a SQLite model (FJS-3581)', async () => {
    await withTrail(async (sys) => {
      const rows = await sys.auditTrail.findMany({ where: { operation: ['create', 'nope'] } })
      expect(rows.length).toBe(2)
      expect(await sys.auditTrail.count({ where: { operation: ['update'] } })).toBe(0)
      expect(await sys.auditTrail.count({ where: { operation: [] } })).toBe(0)
    })
  })

  test('the operators it does know still filter', async () => {
    await withTrail(async (sys) => {
      const rows = await sys.auditTrail.findMany({ where: { model: 'Thing', operation: { in: ['create'] } } })
      expect(rows.length).toBe(2)
      expect(await sys.auditTrail.count({ where: { operation: { not: 'create' } } })).toBe(0)
    })
  })
})
