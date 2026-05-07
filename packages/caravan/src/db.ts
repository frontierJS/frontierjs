// src/db.ts
// SQLite schema, migrations, and prepared statements for Caravan.
// Uses bun:sqlite directly — zero external dependencies.

import { Database } from 'bun:sqlite'
import type { JobRecord, JobStatus, CaravanStats } from './types.ts'

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
    unique_key    TEXT    UNIQUE,
    run_at        INTEGER NOT NULL,
    started_at    INTEGER,
    finished_at   INTEGER,
    error         TEXT,
    created_at    INTEGER NOT NULL
  );

  -- Primary polling index: queue + status + priority + run_at
  CREATE INDEX IF NOT EXISTS jobs_poll
    ON jobs(queue, status, priority DESC, run_at);

  -- Status index for list queries and cleanup
  CREATE INDEX IF NOT EXISTS jobs_status
    ON jobs(status);

  -- Unique key index for deduplication lookups
  CREATE INDEX IF NOT EXISTS jobs_unique_key
    ON jobs(unique_key) WHERE unique_key IS NOT NULL;
`

export function openDb(path: string): Database {
  const db = new Database(path, { create: true })

  // WAL mode — readers don't block writers, better concurrent performance
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(SCHEMA)

  return db
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

function wrap<R, P extends BindObject>(
  stmt: ReturnType<Database['prepare']>
): WrappedStatement<R, P> {
  return {
    run: (p) => stmt.run(prefixKeys(p)) as { changes: number; lastInsertRowid: number | bigint },
    get: (p) => (stmt.get(prefixKeys(p)) as R | null) ?? null,
    all: (p) => (p ? stmt.all(prefixKeys(p)) : stmt.all()) as R[],
  }
}

export function buildStatements(db: Database) {

  // ── Insert ──────────────────────────────────────────────────────────────────

  const insert = wrap<void, {
    id: string; queue: string; name: string; data: string
    status: string; priority: number; max_attempts: number
    retry_delay: string | null; unique_key: string | null
    run_at: number; created_at: number
  }>(db.prepare(`
    INSERT INTO jobs
      (id, queue, name, data, status, priority, max_attempts, retry_delay, unique_key, run_at, created_at)
    VALUES
      ($id, $queue, $name, $data, $status, $priority, $max_attempts, $retry_delay, $unique_key, $run_at, $created_at)
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

  const markDone = wrap<void, { id: string; now: number }>(db.prepare(`
    UPDATE jobs SET
      status      = 'done',
      finished_at = $now,
      error       = NULL
    WHERE id = $id
  `))

  // ── Mark failed (will retry or transition to terminal 'failed' depending on caller) ─

  const markFailed = wrap<void, {
    id: string; status: string; run_at: number; error: string; now: number
  }>(db.prepare(`
    UPDATE jobs SET
      status      = $status,
      finished_at = $now,
      error       = $error,
      run_at      = $run_at
    WHERE id = $id
  `))

  // ── Cancel ──────────────────────────────────────────────────────────────────
  // Allows cancelling pending OR running jobs. Running jobs may still complete
  // their current attempt — the worker checks status before marking done/failed.

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

  const statsByQueue = db.prepare<
    { queue: string; status: string; count: number }, []
  >(`
    SELECT queue, status, COUNT(*) as count
    FROM   jobs
    WHERE  status IN ('pending', 'running', 'failed', 'cancelled')
    GROUP  BY queue, status
  `)

  // ── Get by ID ───────────────────────────────────────────────────────────────

  const getById = wrap<JobRecord, { id: string }>(db.prepare(`
    SELECT * FROM jobs WHERE id = $id
  `))

  // ── Deduplication check ─────────────────────────────────────────────────────

  const findByUniqueKey = wrap<JobRecord, { unique_key: string }>(db.prepare(`
    SELECT * FROM jobs
    WHERE unique_key = $unique_key AND status = 'pending'
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
  const zero = (): { pending: number; running: number; failed: number; cancelled: number } => ({
    pending: 0, running: 0, failed: 0, cancelled: 0,
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

    const status = row.status as 'pending' | 'running' | 'failed' | 'cancelled'
    if (status in result.queues[row.queue]) {
      result.queues[row.queue][status] += row.count
      result.total[status]             += row.count
    }
  }

  return result
}
