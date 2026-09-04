// tests/scale.test.ts
// What the two endpoints an operator reaches during an incident cost, and what
// the sweep holds while it runs (FJS-698).
//
// Every assertion here is a QUERY PLAN or a row count, never a duration. The
// defect was a plan — a filter that selected nothing and steered SQLite onto a
// temp b-tree — so the plan is what has to stay fixed, and a millisecond
// threshold in CI is a coin flip on a loaded machine. The measured numbers that
// motivated each one are in CHANGES.md.
//
// Traps in this file:
//   • Every case needs a real file: `:memory:` gets its own database per
//     connection and the sweep's batching is invisible in one.
//   • A plan is only meaningful against a table SQLite has statistics for or
//     enough rows to care about — a plan asserted over three rows is the
//     planner picking whatever is cheapest for three rows.

import { describe, it, expect, afterEach } from 'bun:test'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { Database } from 'bun:sqlite'
import { openDb, buildStatements, aggregateStats, reclaimFreePages, PLANNED, CLEANUP_BATCH } from '../src/db.ts'

const paths: string[] = []
const open = (): Database => {
  const p = `${tmpdir()}/caravan-scale-${Math.floor(performance.now() * 1000)}-${process.pid}.db`
  paths.push(p)
  return openDb(p)
}

/** `rows` terminal jobs spread across a week, plus `pending` live ones. */
function seed(db: Database, rows: number, pending = 10): void {
  const ins = db.prepare(
    `INSERT INTO jobs (id, queue, name, data, status, priority, attempts, max_attempts, run_at, started_at, finished_at, created_at)
     VALUES (?, ?, 'work', '{}', ?, 0, 1, 3, ?, ?, ?, ?)`
  )
  const now = Date.now(), week = 7 * 24 * 3600 * 1000
  const statuses = ['done', 'done', 'done', 'failed', 'cancelled']
  const queues   = ['default', 'mail', 'reports']
  db.transaction(() => {
    for (let i = 0; i < rows; i++) {
      const at = now - week + Math.floor((i / rows) * week)
      ins.run(`t${i}`, queues[i % 3], statuses[i % 5], at, at, at + 50, at)
    }
    for (let i = 0; i < pending; i++) ins.run(`p${i}`, queues[i % 3], 'pending', now, null, null, now)
  })()
}

const plan = (db: Database, sql: string): string =>
  (db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
    .map(r => r.detail).join(' | ')

afterEach(() => {
  for (const p of paths.splice(0)) for (const f of [p, `${p}-wal`, `${p}-shm`]) rmSync(f, { force: true })
})

describe('the aggregate behind /metrics', () => {
  it('groups from an index, with no temp b-tree', () => {
    const db = open(); seed(db, 5_000)
    const p = plan(db, PLANNED.stats)
    expect(p).toContain('COVERING INDEX')
    expect(p).not.toContain('TEMP B-TREE')
    db.close()
  })

  // The negative control, and the defect stated as SQL. Without it the
  // assertion above is a claim about SQLite rather than about this change:
  // the same rows, one clause different, plan the two opposite ways.
  it('and the filter it used to carry is what made it a scan', () => {
    const db = open(); seed(db, 5_000)
    const p = plan(db, `SELECT queue, status, COUNT(*) FROM jobs
                        WHERE status IN ('pending','running','done','failed','cancelled')
                        GROUP BY queue, status`)
    expect(p).toContain('TEMP B-TREE')
    db.close()
  })

  // The plan tests above grade PLANNED.stats, which is the text the statement
  // is built from. This one grades what it RETURNS, and is what would fail if
  // the filter came back: a status outside the old IN-list reaches the caller.
  it('does not filter by status on the way out', () => {
    const db = open()
    db.exec(`INSERT INTO jobs (id,queue,name,data,status,run_at,created_at)
             VALUES ('a','default','w','{}','quarantined',0,0)`)
    expect(buildStatements(db).statsByQueue.all()).toEqual([
      { queue: 'default', status: 'quarantined', count: 1 },
    ])
    db.close()
  })

  it('answers exactly what the filtered form answered', () => {
    const db = open(); seed(db, 5_000)
    const withFilter = db.query(
      `SELECT queue, status, COUNT(*) as count FROM jobs
       WHERE status IN ('pending','running','done','failed','cancelled')
       GROUP BY queue, status`).all()
    const bare = buildStatements(db).statsByQueue.all()
    expect(JSON.stringify(bare)).toBe(JSON.stringify(withFilter))
    db.close()
  })

  // The dropped WHERE was the only thing excluding a status this build does not
  // know. It is not the only thing: `aggregateStats` counts a row only into a
  // key it already has, so the judgement survives where the clause used to be —
  // paired with a known status, or *the total is 1* proves nothing about which
  // row it came from.
  it('a status this build does not know is not counted, and a known one is', () => {
    const db = open()
    db.exec(`INSERT INTO jobs (id,queue,name,data,status,run_at,created_at)
             VALUES ('a','default','w','{}','done',0,0), ('b','default','w','{}','quarantined',0,0)`)
    const stats = aggregateStats(buildStatements(db).statsByQueue.all(), ['default'])
    expect(stats.total.done).toBe(1)
    expect(Object.values(stats.queues.default).reduce<number>((n, v) => n + (typeof v === 'number' ? v : 0), 0)).toBe(1)
    db.close()
  })
})

describe('the admin list', () => {
  // One case per filter shape, because the statement is chosen per shape: a
  // regression can reach any one of them alone.
  // SEARCH and not merely INDEX. A full index SCAN also says "INDEX", so an
  // assertion on that word alone passes for the combined statement this
  // replaced — measured: reverting the split left every case here green. Only
  // the unfiltered list may scan, and there it is the right plan: walking
  // jobs_created in order and stopping at LIMIT.
  const shapes: Array<[string, string, 'SEARCH' | 'SCAN']> = [
    ['unfiltered',      PLANNED.listAll,    'SCAN'],
    ['by queue',        PLANNED.listQueue,  'SEARCH'],
    ['by status',       PLANNED.listStatus, 'SEARCH'],
    ['by queue+status', PLANNED.listBoth,   'SEARCH'],
  ]
  for (const [label, sql, how] of shapes) {
    it(`${label} is answered by an index ${how} and never sorted`, () => {
      const db = open(); seed(db, 5_000)
      const p = plan(db, sql)
      expect(p).toContain(`${how} jobs USING`)
      expect(p).toContain('INDEX')
      expect(p).not.toContain('TEMP B-TREE')
      db.close()
    })
  }

  // The control: the single statement these four replaced. It cannot use an
  // index on the column it filters, because it is planned before anything is
  // bound and has to allow for the parameter being null.
  // The control, and the defect stated as SQL: the same filter, written the way
  // one statement serving every shape has to write it, cannot seek.
  it('and the combined statement could not seek on either column', () => {
    const db = open(); seed(db, 5_000)
    for (const sql of [
      `SELECT * FROM jobs WHERE ($queue IS NULL OR queue = $queue) ORDER BY created_at DESC LIMIT 50`,
      `SELECT * FROM jobs WHERE ($status IS NULL OR status = $status) ORDER BY created_at DESC LIMIT 50`,
    ]) expect(plan(db, sql)).not.toContain('SEARCH')
    db.close()
  })

  it('returns the same rows through every shape', () => {
    const db = open(); seed(db, 500)
    const s = buildStatements(db)
    const viaShape = s.listJobs.all({ queue: 'mail', status: 'failed', limit: 50, offset: 0 })
    const viaSql   = db.query(`SELECT * FROM jobs WHERE queue = 'mail' AND status = 'failed'
                               ORDER BY created_at DESC LIMIT 50`).all()
    expect(viaShape.map(r => r.id)).toEqual((viaSql as { id: string }[]).map(r => r.id))
    expect(viaShape.length).toBeGreaterThan(0)
    db.close()
  })
})

describe('the cleanup sweep', () => {
  it('deletes a bounded batch per pass, not the whole expiry at once', () => {
    const rows = CLEANUP_BATCH + 2_000
    const db = open(); seed(db, rows, 5)
    const s = buildStatements(db)
    const first = s.cleanup.run({ before: Date.now() })
    // Sized off the owner's own number, so raising it does not quietly turn
    // this into a test that one pass takes everything. What matters is that a
    // pass is BOUNDED and left work behind.
    expect(first.changes).toBe(CLEANUP_BATCH)
    expect(first.changes).toBeLessThan(rows)
    expect(first.changes).toBeGreaterThan(0)
    // Terminal rows, not `done` specifically: a batch of 10 000 over 12 000
    // terminal rows takes every `done` there is and still leaves work behind.
    expect((db.query(`SELECT COUNT(*) c FROM jobs WHERE status IN ('done','failed','cancelled')`)
      .get() as { c: number }).c).toBeGreaterThan(0)
    db.close()
  })

  it('and repeating until a pass changes nothing finishes the job', () => {
    const db = open(); seed(db, CLEANUP_BATCH + 2_000, 5)
    const s = buildStatements(db)
    let passes = 0
    for (;;) { const { changes } = s.cleanup.run({ before: Date.now() }); passes++; if (changes === 0) break }
    expect(passes).toBeGreaterThan(1)
    expect((db.query(`SELECT COUNT(*) c FROM jobs`).get() as { c: number }).c).toBe(5)
    db.close()
  })

  it('leaves a job inside the retention window alone', () => {
    const db = open(); seed(db, 100, 5)
    const s = buildStatements(db)
    const before = Date.now() - 7 * 24 * 3600 * 1000
    for (;;) if (s.cleanup.run({ before }).changes === 0) break
    expect((db.query(`SELECT COUNT(*) c FROM jobs`).get() as { c: number }).c).toBe(105)
    db.close()
  })
})

describe('reclaiming the pages a sweep frees', () => {
  it('a new jobs.db can hand pages back', () => {
    const db = open()
    expect((db.query('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum).toBe(2)
    db.close()
  })

  it('and the reclaim actually moves the freelist', () => {
    const db = open(); seed(db, 20_000, 5)
    const s = buildStatements(db)
    for (;;) if (s.cleanup.run({ before: Date.now() }).changes === 0) break
    const freed = (db.query('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count
    expect(freed).toBeGreaterThan(0)
    reclaimFreePages(db, 100)
    expect((db.query('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count)
      .toBeLessThan(freed)
    db.close()
  })

  // The pair: on a database that cannot do it, the reclaim is a no-op rather
  // than an error. Every jobs.db written before this could reclaim is one.
  it('and is silent on a database that cannot', () => {
    const db = open()
    db.exec('PRAGMA auto_vacuum = NONE')
    expect(() => reclaimFreePages(db)).not.toThrow()
    db.close()
  })
})
