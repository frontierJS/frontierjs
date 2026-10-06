// test/read-snapshot.test.ts
// The read connection sees every commit made after an EXPLAIN (`FJS-1753`).
// bun leaves an EXPLAIN statement's VM active once it has run, whichever of
// all/get/values/run ran it, and while it is active the connection's next read
// transaction never ends: every later read answers that snapshot, ORM and sql
// alike, for as long as the statement lives. The statement cache kept it for
// the life of the process.
//
// Traps in this file:
//   • The read straight after the EXPLAIN is CORRECT — it is the snapshot that
//     gets held. Only a write after that read, read back, shows the loss, which
//     is why an EXPLAIN followed by one check looked fine.
//   • A file database, because `:memory:` has one connection and nothing to
//     fall behind.

import { describe, it, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '../src/index.js'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

const SCHEMA = `
model Note {
  id    Int    @id
  label String
}
`

async function client() {
  const dir = mkdtempSync(join(tmpdir(), 'ls-snapshot-'))
  dirs.push(dir)
  const db: any = await createClient({ schema: SCHEMA, db: join(dir, 'app.db') })
  await db.note.create({ data: { id: 1, label: 'a' } })
  return db
}

// Two rounds, because the first read after the trigger is the one that pins.
async function tracksCommits(db: any) {
  const seen: string[] = []
  for (const label of ['b', 'c', 'd']) {
    await db.note.update({ where: { id: 1 }, data: { label } })
    seen.push((await db.note.findFirst({ where: { id: 1 } })).label)
    const [row] = await db.sql`SELECT label FROM note WHERE id = 1`
    seen.push(row.label)
  }
  return seen
}

describe('the read connection after an EXPLAIN', () => {
  for (const [name, run] of [
    ['EXPLAIN QUERY PLAN with a parameter', (db: any) => db.sql`EXPLAIN QUERY PLAN SELECT id FROM note WHERE label = ${'a'}`],
    ['EXPLAIN QUERY PLAN with none',        (db: any) => db.sql`EXPLAIN QUERY PLAN SELECT id FROM note WHERE label = 'a'`],
    ['EXPLAIN',                             (db: any) => db.sql`EXPLAIN SELECT id FROM note`],
    ['an EXPLAIN behind a comment',         (db: any) => db.sql`-- why
      EXPLAIN QUERY PLAN SELECT id FROM note`],
  ] as const) {
    it(`sees later commits after ${name}`, async () => {
      const db = await client()
      const plan = await run(db)
      expect(plan.length).toBeGreaterThan(0)
      expect(await tracksCommits(db)).toEqual(['b', 'b', 'c', 'c', 'd', 'd'])
      // Run twice: a cached statement re-run is the shape a hot path has.
      await run(db)
      expect(await tracksCommits(db)).toEqual(['b', 'b', 'c', 'c', 'd', 'd'])
      db.$close()
    })
  }

  it('the control: a SELECT in the same place never pinned', async () => {
    const db = await client()
    await db.sql`SELECT id FROM note WHERE label = ${'a'}`
    expect(await tracksCommits(db)).toEqual(['b', 'b', 'c', 'c', 'd', 'd'])
    db.$close()
  })
})
