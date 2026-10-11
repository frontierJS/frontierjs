// trail-batch.test.ts — the trail entries one tick queues are written as one batch.
//
// A trail write costs its commit, not its entry: five B-tree pages into the
// index's WAL and the checkpoints they bring, ~90 µs against ~3 µs to build the
// entry. One commit per line made `@@trail` the largest per-write cost in the
// ablation bench (`FJS-2317`). What a batch must not cost is a line: one entry
// the trail's own model refuses drops that entry and not its neighbours.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createClient, autoMigrate } from '../src/index.js'
import { fireLog } from '../src/core/audit-log.js'

const tick = () => new Promise((r) => setImmediate(r))

describe('fireLog batches per log table per tick', () => {
  test('entries queued in one tick reach the table as one createMany, in order', async () => {
    const calls: string[] = []
    const table = {
      create:     async ({ data }: any) => { calls.push(`create ${data.n}`) },
      createMany: async ({ data }: any) => { calls.push(`createMany ${data.map((d: any) => d.n).join(',')}`) },
    }
    const stats = { dropped: 0, written: 0 }
    fireLog(table, { n: 1 }, stats)
    fireLog(table, { n: 2 }, stats)
    fireLog(table, { n: 3 }, stats)
    await tick(); await tick()
    expect(calls).toEqual(['createMany 1,2,3'])
    expect(stats).toMatchObject({ written: 3, dropped: 0 })

    // The next tick starts a new batch, and a lone entry stays a create.
    fireLog(table, { n: 4 }, stats)
    await tick(); await tick()
    expect(calls).toEqual(['createMany 1,2,3', 'create 4'])
  })
})

describe('a real trail', () => {
  test('jsonl: every line lands, in write order, and the stats count each one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fjs-trail-batch-'))
    try {
      const db: any = await createClient({ resolveFrom: dir, schema: `
        database main  { path "${dir}/main.db" }
        database audit { path "${dir}/audit/" driver trail }
        model Thing { id Int @id  name String  @@trail(audit) }
      ` })
      const sys = db.asSystem()
      for (let i = 1; i <= 20; i++) await sys.thing.create({ data: { id: i, name: `t${i}` } })
      await tick(); await tick()

      const lines = readFileSync(join(dir, 'audit', 'AuditTrail.jsonl'), 'utf8').split('\n').filter(Boolean)
      expect(lines.map(l => JSON.parse(l).records)).toEqual(Array.from({ length: 20 }, (_, i) => [i + 1]))
      // The index rows name the right lines — an indexed read answers each one.
      expect(await sys.auditTrail.count({ where: { model: 'Thing' } })).toBe(20)
      expect(db.$logStats()).toMatchObject({ written: 20, dropped: 0 })
      db.$close()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('sql: an entry the trail model refuses costs that entry alone', async () => {
    const db: any = await createClient({ db: ':memory:', schema: `
      database main { path ":memory:" model AuditRow }
      enum Audited { Thing }
      model AuditRow {
        id        Int      @id @default(autoincrement())
        operation String
        model     Audited
        records   Json
        createdAt DateTime @default(now())
      }
      model Thing { id Int @id  name String  @@trail(main) }
      model Other { id Int @id  name String  @@trail(main) }
    ` })
    await autoMigrate(db)
    const sys = db.asSystem()
    const warn = console.warn
    console.warn = () => {}
    try {
      await Promise.all([
        sys.thing.create({ data: { id: 1, name: 'a' } }),
        sys.other.create({ data: { id: 1, name: 'b' } }),
        sys.thing.create({ data: { id: 2, name: 'c' } }),
      ])
      await tick(); await tick(); await tick()
    } finally { console.warn = warn }

    const rows = await sys.auditRow.findMany({ orderBy: { id: 'asc' } })
    expect(rows.map((r: any) => r.records)).toEqual([[1], [2]])
    expect(db.$logStats()).toMatchObject({ written: 2, dropped: 1 })
    db.$close()
  })
})

describe('a trail nothing has written yet', () => {
  test('FJS-2379: a read answers no rows instead of refusing to open the index', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fjs-trail-unwritten-'))
    try {
      const db: any = await createClient({ resolveFrom: dir, schema: `
        database main  { path "${dir}/main.db" }
        database audit { path "${dir}/audit/" driver trail }
        model Thing { id Int @id  name String  @@trail(audit) }
      ` })
      // A where on an indexed field takes the index path, which is the one that opens the sidecar.
      expect(await db.asSystem().auditTrail.findMany({ where: { model: 'Thing' } })).toEqual([])
      expect(await db.asSystem().auditTrail.count({ where: { model: 'Thing' } })).toBe(0)
      expect(await db.asSystem().auditTrail.findMany()).toEqual([])
      await db.asSystem().thing.create({ data: { id: 1, name: 'a' } })
      await tick(); await tick()
      expect((await db.asSystem().auditTrail.findMany()).length).toBeGreaterThan(0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
