// src/db.ts
// SQLite schema, migrations, and prepared statements for Caravan.
// Uses bun:sqlite directly — zero external dependencies.

import { Database } from 'bun:sqlite'
import type { JobRecord, JobStatus, CaravanStats, QueueStats } from './types.ts'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS jobs (
    id            TEXT    PRIMARY KEY,
    queue         TEXT    NOT NULL DEFAULT 'default',
    name          TEXT    NOT NULL,
    data          TEXT    NOT NULL,
    status        TEXT    NOT NULL DEFAULT 'pending',
    priority      INTEGER NOT NULL DEFAULT 0,
    attempts      INTEGER NOT NULL DEFAULT 0,
    max_attempts  INTEGER NOT NULL DEFAULT 3,
    retry_delay   TEXT,
    -- NOT column-level UNIQUE. See jobs_unique_live below: a dedup key is
    -- unique among LIVE jobs, not for the life of the table.
    unique_key    TEXT,
    run_at        INTEGER NOT NULL,
    started_at    INTEGER,
    finished_at   INTEGER,
    error         TEXT,
    created_at    INTEGER NOT NULL,
    -- WHO asked for this work. The id of the principal in scope at dispatch,
    -- NULL when nobody was — a cron fire, a boot-time enqueue, standalone use.
    -- An id rather than a session: the standing is re-resolved when the job
    -- runs, so a caller demoted in between is graded at what they hold then.
    actor_id      TEXT
  );

  -- Primary polling index: queue + status + priority + run_at
  CREATE INDEX IF NOT EXISTS jobs_poll
    ON jobs(queue, status, priority DESC, run_at);

  -- Status index for list queries and cleanup
  CREATE INDEX IF NOT EXISTS jobs_status
    ON jobs(status);

  -- Deduplication. A 'unique' key means "do not queue this twice AT ONCE" —
  -- it is a lock on work in flight, not an idempotency key for all time. The
  -- column used to carry a plain UNIQUE constraint, which said the opposite,
  -- and the two halves disagreed:
  --
  --   • dispatch() looked for a PENDING job with the key and, finding none,
  --     inserted — straight into the table-wide constraint the moment the
  --     first job had finished:
  --       500 GeneralError: UNIQUE constraint failed: jobs.unique_key
  --   • making the lookup match ANY status fixed that and broke the other side:
  --     a key derived from a row id ('book-courier:4') silently matched a job
  --     from a deleted order whose id SQLite had reused, and the new work never
  --     ran. Nothing failed; a courier was simply never booked.
  --
  -- A partial unique index says what was meant. Terminal jobs keep their key
  -- for inspection and stop blocking new work. Both halves were found in one
  -- afternoon by example/'s courier booking, 2026-08-06.
  CREATE UNIQUE INDEX IF NOT EXISTS jobs_unique_live
    ON jobs(unique_key) WHERE unique_key IS NOT NULL AND status IN ('pending', 'running');

  -- Lookup index for the dedup check and for admin queries by key.
  CREATE INDEX IF NOT EXISTS jobs_unique_key
    ON jobs(unique_key) WHERE unique_key IS NOT NULL;
`

export function openDb(path: string): Database {
  const db = new Database(path, { create: true })

  // WAL mode — readers don't block writers, better concurrent performance
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  migrateUniqueKey(db)
  db.exec(SCHEMA)
  addActorColumn(db)

  return db
}

/**
 * Add `actor_id` to a jobs table created before jobs had a principal.
 *
 * `CREATE TABLE IF NOT EXISTS` leaves an existing table exactly as it was, so
 * without this every dispatch against an old jobs.db fails on an unknown
 * column. Unlike the unique_key rebuild this is a plain ADD COLUMN — the column
 * is nullable with no default, which SQLite appends in place.
 *
 * Jobs already queued get NULL and therefore run as the app itself, which is
 * the only honest answer: nothing recorded who asked for them.
 */
function addActorColumn(db: Database): void {
  const cols = db.query<{ name: string }, []>(`PRAGMA table_info(jobs)`).all()
  if (cols.some(c => c.name === 'actor_id')) return
  db.exec(`ALTER TABLE jobs ADD COLUMN actor_id TEXT`)
}

/**
 * Drop the table-wide UNIQUE on `unique_key` from a database created before
 * 2026-08-06.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so
 * an existing jobs.db would keep the old constraint and keep 500-ing on a
 * repeat dispatch — with a schema that no longer explains why. SQLite cannot
 * drop a column constraint, so this is the standard rebuild: new table, copy,
 * drop, rename, in one transaction.
 *
 * Cheap to skip: one sqlite_master read, and the string it looks for cannot
 * appear in the current schema.
 */
function migrateUniqueKey(db: Database): void {
  const row = db.query<{ sql: string }, []>(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'`
  ).get()
  if (!row?.sql || !/unique_key\s+TEXT\s+UNIQUE/i.test(row.sql)) return

  db.exec('BEGIN')
  try {
    db.exec(`
      CREATE TABLE jobs_new (
        id            TEXT    PRIMARY KEY,
        queue         TEXT    NOT NULL DEFAULT 'default',
        name          TEXT    NOT NULL,
        data          TEXT    NOT NULL,
        status        TEXT    NOT NULL DEFAULT 'pending',
        priority      INTEGER NOT NULL DEFAULT 0,
        attempts      INTEGER NOT NULL DEFAULT 0,
        max_attempts  INTEGER NOT NULL DEFAULT 3,
        retry_delay   TEXT,
        unique_key    TEXT,
        run_at        INTEGER NOT NULL,
        started_at    INTEGER,
        finished_at   INTEGER,
        error         TEXT,
        created_at    INTEGER NOT NULL
      );
      INSERT INTO jobs_new SELECT
        id, queue, name, data, status, priority, attempts, max_attempts,
        retry_delay, unique_key, run_at, started_at, finished_at, error, created_at
      FROM jobs;
      DROP TABLE jobs;
      ALTER TABLE jobs_new RENAME TO jobs;
    `)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

// ─── Prepared statement wrappers ──────────────────────────────────────────────

// Bun 1.3+ requires named bind params to be passed with their SQL prefix
// (e.g. `{ $id: x }` not `{ id: x }`). To keep call sites readable, we wrap
// each prepared statement so callers can still pass plain-keyed objects.

type BindObject = Record<string, unknown>

function prefixKeys(params: BindObject): BindObject {
  const out: BindObject = {}
  for (const k in params) out['$' + k] = params[k]
  return out
}

interface WrappedStatement<R, P extends BindObject> {
  run(params: P): { changes: number; lastInsertRowid: number | bigint }
  get(params: P): R | null
  all(params?: P): R[]
}

// bun-types declares run/get/all as taking only positional bindings, so a
// named-parameter object is rejected at compile time even though bun:sqlite
// accepts it at runtime. Narrow the gap in one place rather than at each call.
interface NamedBindStatement {
  run(params: BindObject): { changes: number; lastInsertRowid: number | bigint }
  get(params: BindObject): unknown
  all(params?: BindObject): unknown[]
}

function wrap<R, P extends BindObject>(
  stmt: ReturnType<Database['prepare']>
): WrappedStatement<R, P> {
  const s = stmt as unknown as NamedBindStatement
  return {
    run: (p) => s.run(prefixKeys(p)),
    get: (p) => (s.get(prefixKeys(p)) as R | null) ?? null,
    all: (p) => (p ? s.all(prefixKeys(p)) : s.all()) as R[],
  }
}

export function buildStatements(db: Database) {

  // ── Insert ──────────────────────────────────────────────────────────────────

  const insert = wrap<void, {
    id: string; queue: string; name: string; data: string
    status: string; priority: number; max_attempts: number
    retry_delay: string | null; unique_key: string | null
    run_at: number; created_at: number; actor_id: string | null
  }>(db.prepare(`
    INSERT INTO jobs
      (id, queue, name, data, status, priority, max_attempts, retry_delay, unique_key, run_at, created_at, actor_id)
    VALUES
      ($id, $queue, $name, $data, $status, $priority, $max_attempts, $retry_delay, $unique_key, $run_at, $created_at, $actor_id)
  `))

  // ── Claim next job (atomic — uses RETURNING to avoid race conditions) ────────
  // SQLite's BEGIN IMMEDIATE ensures only one worker claims a job at a time.

  const claimNext = wrap<JobRecord, { queue: string; now: number }>(db.prepare(`
    UPDATE jobs SET
      status     = 'running',
      started_at = $now,
      attempts   = attempts + 1
    WHERE id = (
      SELECT id FROM jobs
      WHERE  queue  = $queue
        AND  status = 'pending'
        AND  run_at <= $now
      ORDER BY priority DESC, run_at ASC
      LIMIT 1
    )
    RETURNING *
  `))

  // ── Mark done ───────────────────────────────────────────────────────────────
  // Guarded on 'running': cancel() can land while the attempt is in flight, and
  // an unguarded UPDATE writes 'done' over the cancellation the caller asked for.
  // `changes` is 0 when that happens — the worker reads it before announcing.

  const markDone = wrap<void, { id: string; now: number }>(db.prepare(`
    UPDATE jobs SET
      status      = 'done',
      finished_at = $now,
      error       = NULL
    WHERE id = $id AND status = 'running'
  `))

  // ── Mark failed (will retry or transition to terminal 'failed' depending on caller) ─
  // Same guard, and it carries more: without it a cancelled job whose handler
  // then threw is written back to 'pending' and runs again.

  const markFailed = wrap<void, {
    id: string; status: string; run_at: number; error: string; now: number
  }>(db.prepare(`
    UPDATE jobs SET
      status      = $status,
      finished_at = $now,
      error       = $error,
      run_at      = $run_at
    WHERE id = $id AND status = 'running'
  `))

  // ── Cancel ──────────────────────────────────────────────────────────────────
  // Allows cancelling pending OR running jobs. A running job still completes its
  // current attempt; the status guard on markDone/markFailed is what keeps the
  // cancellation.

  const cancel = wrap<void, { id: string; now: number }>(db.prepare(`
    UPDATE jobs SET
      status      = 'cancelled',
      finished_at = $now
    WHERE id = $id AND status IN ('pending', 'running')
  `))

  // ── Retry a terminal job ────────────────────────────────────────────────────
  // Works on both 'failed' and 'cancelled' — explicit retry intent overrides
  // whatever stopped the job in the first place.

  const retryTerminal = wrap<void, { id: string; now: number }>(db.prepare(`
    UPDATE jobs SET
      status    = 'pending',
      error     = NULL,
      attempts  = 0,
      run_at    = $now
    WHERE id = $id AND status IN ('failed', 'cancelled')
  `))

  // ── Stats ───────────────────────────────────────────────────────────────────
  // No bind params — used directly via stmt.all() with no key prefixing needed.

  // `done` is counted too, and it is the only number here that says the queue
  // is WORKING: without it a healthy busy queue reports zeros on every line,
  // which is what an empty one reports. It counts the retention window rather
  // than all time — the cleanup sweep deletes terminal jobs past
  // `cleanupAfter`, and that is what makes it a rate instead of a total.
  const statsByQueue = db.prepare<
    { queue: string; status: string; count: number }, []
  >(`
    SELECT queue, status, COUNT(*) as count
    FROM   jobs
    WHERE  status IN ('pending', 'running', 'done', 'failed', 'cancelled')
    GROUP  BY queue, status
  `)

  // ── Get by ID ───────────────────────────────────────────────────────────────

  const getById = wrap<JobRecord, { id: string }>(db.prepare(`
    SELECT * FROM jobs WHERE id = $id
  `))

  // ── Deduplication check ─────────────────────────────────────────────────────
  //
  // IN FLIGHT — pending or running. A `unique` key is a lock on work that has
  // not finished yet, not an idempotency key for all time; the partial unique
  // index in SCHEMA enforces exactly this set, so the guard and the constraint
  // now agree about how long a key lasts. See the comment there for the two
  // ways they used to disagree.
  //
  // `running` matters: without it, a second dispatch while the first job is
  // executing slips past the guard and hits the index instead of returning the
  // job already doing the work.
  const findByUniqueKey = wrap<JobRecord, { unique_key: string }>(db.prepare(`
    SELECT * FROM jobs
    WHERE unique_key = $unique_key AND status IN ('pending', 'running')
    LIMIT 1
  `))

  // ── List jobs ────────────────────────────────────────────────────────────────

  const listJobs = wrap<JobRecord, {
    queue: string | null; status: string | null; limit: number; offset: number
  }>(db.prepare(`
    SELECT * FROM jobs
    WHERE ($queue IS NULL OR queue = $queue)
      AND ($status IS NULL OR status = $status)
    ORDER BY created_at DESC
    LIMIT $limit OFFSET $offset
  `))

  // ── Cleanup old terminal jobs ───────────────────────────────────────────────

  const cleanup = wrap<void, { before: number }>(db.prepare(`
    DELETE FROM jobs
    WHERE status IN ('done', 'failed', 'cancelled')
      AND (finished_at < $before OR finished_at IS NULL)
  `))

  return {
    insert,
    claimNext,
    markDone,
    markFailed,
    cancel,
    retryTerminal,
    statsByQueue,
    getById,
    findByUniqueKey,
    listJobs,
    cleanup,
  }
}

export type Statements = ReturnType<typeof buildStatements>

// ─── Stats aggregation ────────────────────────────────────────────────────────

export function aggregateStats(
  rows:   { queue: string; status: string; count: number }[],
  queues: string[]
): CaravanStats {
  const zero = (): QueueStats => ({
    pending: 0, running: 0, done: 0, failed: 0, cancelled: 0,
  })

  const result: CaravanStats = {
    queues: {},
    total:  zero(),
  }

  // Pre-populate all known queues with zeros
  for (const q of queues) {
    result.queues[q] = zero()
  }

  for (const row of rows) {
    // Add unknown queues that appear in DB
    if (!result.queues[row.queue]) {
      result.queues[row.queue] = zero()
    }

    const status = row.status as keyof QueueStats
    if (status in result.queues[row.queue]) {
      result.queues[row.queue][status] += row.count
      result.total[status]             += row.count
    }
  }

  return result
}
