// test/where-or-hoist.test.ts
//
// `{ ownerId, OR: [{ band0 }, { band1 }, …] }` over (ownerId, bandN) indexes
// (FJS-3912). Written flat, SQLite takes the ownerId equality as the one index
// and filters the OR over every row of that owner: 23 ms a probe on 21k rows.
// Written `OR: [{ ownerId, band0 }, …]` it runs a MULTI-INDEX OR at 0.47 ms. The
// two say the same thing, so buildWhere writes the second whichever the caller
// wrote (a database populated after its migration has no sqlite_stat1 rows, so
// the planner has only its defaults to choose with): a scalar equality beside an OR moves into each branch.

import { describe, test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '../src/index.js'

const SCHEMA = `
  model ScanFile {
    id      Int    @id
    ownerId String
    band0   Int
    band1   Int
    band2   Int
    @@index([ownerId, band0])
    @@index([ownerId, band1])
    @@index([ownerId, band2])
  }
`

async function withDb(fn: (sys: any, plan: (where: any) => string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'litestone-or-hoist-'))
  const file = join(dir, 'db.sqlite')
  try {
    const seen: any[] = []
    const db: any = await createClient({ schema: SCHEMA, db: file, onQuery: (e: any) => seen.push(e) })
    const sys = db.asSystem()
    await sys.scanFile.createMany({
      data: Array.from({ length: 2000 }, (_, i) => ({ id: i, ownerId: 'o' + (i % 2), band0: i, band1: i + 1000, band2: i + 2000 })),
    })
    const raw = new Database(file)
    try {
      await fn(sys, (where: any) => {
        seen.length = 0
        return sys.scanFile.findMany({ where }).then(() => {
          const q = seen.find(e => e.operation === 'findMany')
          return (raw.prepare('EXPLAIN QUERY PLAN ' + q.sql).all(...q.params) as any[]).map(r => r.detail).join(' | ')
        }) as any
      })
    } finally { raw.close() }
    await db.$close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

describe('a scalar equality beside an OR moves into each branch (FJS-3912)', () => {

  test('the plan is a MULTI-INDEX OR, as when the caller repeated ownerId', async () => {
    await withDb(async (sys, plan) => {
      const flat = await plan({ ownerId: 'o0', OR: [{ band0: 4 }, { band1: 1006 }, { band2: 2010 }] })
      const spelled = await plan({ OR: [{ ownerId: 'o0', band0: 4 }, { ownerId: 'o0', band1: 1006 }, { ownerId: 'o0', band2: 2010 }] })
      expect(spelled).toContain('MULTI-INDEX OR')
      expect(flat).toContain('MULTI-INDEX OR')
    })
  })

  test('…and answers the same rows, beside a branch that repeats the key and one that is empty', async () => {
    await withDb(async (sys) => {
      const ids = async (where: any) => (await sys.scanFile.findMany({ where, orderBy: { id: 'asc' } })).map((r: any) => r.id)
      expect(await ids({ ownerId: 'o0', OR: [{ band0: 4 }, { band1: 1006 }, { band2: 2011 }] })).toEqual([4, 6])
      // a branch naming the same key with another value is an AND, so it matches nothing
      expect(await ids({ ownerId: 'o0', OR: [{ ownerId: 'o1', band0: 4 }, { band0: 6 }] })).toEqual([6])
      // an empty branch is dropped exactly as before
      expect(await ids({ ownerId: 'o1', OR: [{}, { band0: 5 }] })).toEqual([5])
      // an empty OR leaves the equality standing
      expect((await ids({ ownerId: 'o1', OR: [] })).length).toBe(1000)
      // null is an equality too
      expect(await ids({ ownerId: 'o0', band0: 4, OR: [{ band1: 1004 }, { band1: 1006 }] })).toEqual([4])
    })
  })
})
