// jsonl-index-drift.test.ts — the companion index rebuilds when its SHAPE moves.
//
// A jsonl/logger database keeps a `<file>.index.db` of byte offsets beside it,
// with one column per indexed field. The index is a CACHE — every column is
// re-derivable from the .jsonl, which is the source of truth — so the right
// answer to a shape that no longer matches is always to drop it and refill.
//
// Two ways the shape can be wrong and only one was checked. A changed TYPE
// fails a write with a datatype error; a MISSING column fails it with `has no
// column named …`, and that is what an EXISTING trail does the first time its
// model gains an indexed field. `@@log(audit)` is fire-and-forget and swallows
// the failure, so the symptom is a deployment that upgrades, warns once, and
// silently stops recording — measured while adding `@@index([correlationId])`
// to the logger auto-model, which is exactly that upgrade for every app that
// already has a trail.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, appendFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { createClient } from '../src/index.js'

const tick = () => new Promise((r) => setImmediate(r))

const SCHEMA = (dir: string) => `
  database main  { path ":memory:" }
  database audit { path "${dir}/audit/" driver logger }
  model Thing { id String @id @default(uuid())  name String  @@log(audit) }
`

/** A trail whose index table was built with `cols`, as an older release left it. */
function seedIndex(dir: string, cols: string) {
  mkdirSync(join(dir, 'audit'), { recursive: true })
  appendFileSync(join(dir, 'audit', 'auditLogs.jsonl'), '')
  const d = new Database(join(dir, 'audit', 'auditLogs.jsonl.index.db'))
  d.run(`CREATE TABLE "auditLogs_idx" (${cols}, "_offset" INTEGER NOT NULL, PRIMARY KEY ("_offset")) STRICT;`)
  d.close()
}

async function writeOne(dir: string) {
  const db: any = await createClient({ schema: SCHEMA(dir), resolveFrom: dir })
  await db.asSystem().thing.create({ data: { name: 'x' } })
  await tick()
  const rows = await db.asSystem().auditLogs.findMany({})
  db.$close()
  return rows
}

describe('the jsonl companion index rebuilds rather than failing every write', () => {

  test('an index MISSING a newly indexed column is rebuilt', async () => {
    // The upgrade case. Before the fix this warned once and dropped every audit
    // write from then on — the whole trail, silently, on a live deployment.
    const dir = mkdtempSync(join(tmpdir(), 'fjs-idx-'))
    try {
      seedIndex(dir, '"actorId" ANY, "model" TEXT')
      const rows = await writeOne(dir)
      expect(rows).toHaveLength(1)
      expect(rows[0].operation).toBe('create')
      // Rebuilt with the column, not merely tolerated.
      const d = new Database(join(dir, 'audit', 'auditLogs.jsonl.index.db'))
      const cols = d.query('SELECT name FROM pragma_table_info(?)').all('auditLogs_idx') as any[]
      d.close()
      expect(cols.map(c => c.name)).toContain('correlationId')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('an index with a CHANGED type is still rebuilt', async () => {
    // The case that was already covered. Kept as the negative control for the
    // one above: a fix that only handled the new-column case would pass that
    // test and quietly drop this behaviour.
    const dir = mkdtempSync(join(tmpdir(), 'fjs-idx-'))
    try {
      seedIndex(dir, '"actorId" TEXT, "model" TEXT, "correlationId" TEXT')
      const rows = await writeOne(dir)
      expect(rows).toHaveLength(1)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('an index whose shape already agrees is NOT dropped', async () => {
    // The rebuild throws away offsets, so doing it on every open would make an
    // append-only log rescan itself for ever. Two writes across two clients: if
    // the second open rebuilt, the first row's offset would be gone.
    const dir = mkdtempSync(join(tmpdir(), 'fjs-idx-'))
    try {
      const first = await writeOne(dir)
      expect(first).toHaveLength(1)
      const second = await writeOne(dir)
      expect(second).toHaveLength(2)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
