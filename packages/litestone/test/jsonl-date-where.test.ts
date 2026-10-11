// jsonl-date-where.test.ts — a Date in a jsonl `where` compares as the ISO string stored (`FJS-2567`).
//
// `matchCondition` read a Date as an operator object with no operator keys, so
// `{ createdAt: new Date(0) }` refused nothing, filtered nothing and answered every row.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createClient } from '../src/index.js'

const tick = () => new Promise((r) => setImmediate(r))

async function withTrail(fn: (sys: any) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'fjs-jsonl-date-'))
  try {
    const db: any = await createClient({ resolveFrom: dir, schema: `
      database main  { path "${dir}/main.db" }
      database audit { path "${dir}/audit/" driver trail }
      model Thing { id Int @id  name String  @@trail(audit) }
    ` })
    const sys = db.asSystem()
    await sys.thing.create({ data: { id: 1, name: 'a' } })
    await tick(); await tick()
    try { await fn(sys) } finally { db.$close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

describe('a Date in a jsonl where', () => {
  test('equality on a Date that is not the stored instant answers nothing', async () => {
    await withTrail(async (sys) => {
      expect((await sys.auditTrail.findMany({ where: { createdAt: new Date(0) } })).length).toBe(0)
    })
  })

  test('the stored instant matches, bare and inside operators', async () => {
    await withTrail(async (sys) => {
      const [row] = await sys.auditTrail.findMany({})
      const at = new Date(row.createdAt)
      expect((await sys.auditTrail.findMany({ where: { createdAt: at } })).length).toBe(1)
      expect((await sys.auditTrail.findMany({ where: { createdAt: { gte: new Date(0) } } })).length).toBe(1)
      expect((await sys.auditTrail.findMany({ where: { createdAt: { lt: new Date(0) } } })).length).toBe(0)
      expect((await sys.auditTrail.findMany({ where: { createdAt: { in: [at] } } })).length).toBe(1)
      expect((await sys.auditTrail.findMany({ where: { createdAt: { not: at } } })).length).toBe(0)
    })
  })
})
