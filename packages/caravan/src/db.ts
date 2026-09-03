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
    actor_id      TEXT,
    -- WHICH TENANT the work is for, where the app declares tenancy. Resolved
    -- at dispatch and re-bound when the job runs, so a handler reaches the same
    -- rows the request that asked for it could. NULL is honest and common: an
    -- app with no tenancy, and work that is the app's own.
    --
    -- A tenant is stored where a session deliberately is not, and the two are
    -- not the same kind of thing. This is a pointer to a set of rows; the
    -- standing that decides what may be done with them is still re-resolved
    -- from actor_id when the job runs.
    tenant_id     TEXT,
    -- WHICH Caravan instance is executing this row. Written by the claim,
    -- cleared when the row leaves 'running'. Recovery cannot tell a crashed
    -- process's job from a live one's without it, and one jobs.db is trivially
    -- opened twice — two replicas, a web process beside a worker one.
    owner_id      TEXT
  );

  -- One row per Caravan instance that has started, with the last time it said
  -- so. This is what makes 'running' decidable across processes: a row whose
  -- owner is heartbeating belongs to somebody still executing it, and a row
  -- whose owner has gone quiet past the lease is work nothing is doing.
  CREATE TABLE IF NOT EXISTS job_owners (
    id         TEXT    PRIMARY KEY,
    started_at INTEGER NOT NULL,
    seen_at    INTEGER NOT NULL
  );

  -- Recovery sweeps running rows by owner, every lease period.
  CREATE INDEX IF NOT EXISTS jobs_owner
    ON jobs(owner_id) WHERE status = 'running';

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

/**
 * Did this throw come from inserting a row whose primary key is taken?
 *
 * `dispatch({ id })` states an id to make a retried handoff a no-op, and two
 * processes retrying at once both read nothing before inserting — so the key
 * is what decides, and this is how that answer is told apart from a real
 * failure. Matched on the message because bun:sqlite surfaces the constraint
 * name there and nowhere else.
 */
export function isPrimaryKeyCollision(err: unknown): boolean {
  const message = (err as { message?: string } | null)?.message ?? ''
  return /UNIQUE constraint failed: jobs\.id/i.test(message)
}

/**
 * Did this throw come from the partial unique index on `unique_key`?
 *
 * `dispatch({ unique })` reads `findByUniqueKey` and then inserts, which is
 * check-then-act across processes: two of them read nothing and both insert,
 * and the loser used to surface a raw `UNIQUE constraint failed` out of an
 * HTTP request — a 500 under exactly the shape the option exists to make safe.
 * The index is what decides, so the loser asks it who won.
 */
export function isUniqueKeyCollision(err: unknown): boolean {
  const message = (err as { message?: string } | null)?.message ?? ''
  return /UNIQUE constraint failed: jobs\.unique_key/i.test(message)
}

/**
 * Run a statement that another process's lock can refuse, retrying briefly.
 *
 * SQLite does not invoke the busy handler for a journal-mode change or for the
 * schema-creation block, so `busy_timeout` covers neither: four processes
 * opening a jobs.db that does not exist yet — a fresh volume, first boot, the
 * deployment this package advertises — threw `database is locked` on 36 of 40
 * starts. Bounded and short: a lock held longer than this is a different
 * problem and is worth surfacing rather than waiting out.
 */
function withOpenRetry(label: string, fn: () => void): void {
  const deadline = Date.now() + 2_000
  for (;;) {
    try { return fn() } catch (err) {
      const message = (err as { message?: string } | null)?.message ?? ''
      if (!/locked|busy/i.test(message) || Date.now() >= deadline)
        throw new Error(`[Caravan] ${label}: ${message}`, { cause: err })
      Bun.sleepSync(5 + Math.floor(Math.random() * 20))
    }
  }
}

export function openDb(
  path: string,
  busyTimeout = 5000,
  synchronous: 'NORMAL' | 'FULL' = 'NORMAL',
): Database {
  const db = new Database(path, { create: true })

  // Refused rather than coerced: `Number('5s') || 0` is zero, which is SQLite's
  // *fail immediately* — so a typo would silently buy the opposite of what it
  // asked for, on the one database every process in the app writes.
  if (!Number.isInteger(busyTimeout) || busyTimeout < 0)
    throw new Error(`[Caravan] busyTimeout must be a whole number of milliseconds (0 or more), got ${JSON.stringify(busyTimeout)}`)
  // Set first, because it is connection-local and takes no lock, and because
  // everything below it is what a second process can be holding.
  //
  // A jobs database is shared by construction, so the wait is the normal case.
  // Configurable because the two callers want different answers: a worker
  // draining a batch can afford to wait, an API dispatching a job cannot
  // (`FJS-569` — and the wait blocks this process's event loop while it runs).
  db.exec(`PRAGMA busy_timeout = ${busyTimeout}`)

  // WAL mode — readers don't block writers, better concurrent performance.
  //
  // The READ is inside the retry as well as the change: on a database another
  // process is mid-mode-change on, asking what the mode is throws the same
  // `database is locked` that setting it does.
  withOpenRetry('could not put the jobs database into WAL mode', () => {
    const mode = db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()
    if (mode?.journal_mode?.toLowerCase() !== 'wal') db.exec('PRAGMA journal_mode = WAL')
  })
  db.exec('PRAGMA foreign_keys = ON')
  // WAL + NORMAL fsyncs at a checkpoint rather than at every commit: a dispatch
  // from an HTTP handler costs a fraction of a millisecond instead of 3ms, and
  // 2000 inserts take 136ms instead of 5913ms. What it trades is durability
  // across a POWER LOSS — not a process crash, which WAL survives either way —
  // where the last committed transactions can be lost. That is the right trade
  // for a queue: a lost claim is a running row whose owner never heartbeats
  // again, which the lease sweep already recovers by design. FULL is the option
  // for a deployment that would rather pay the fsync.
  db.exec(`PRAGMA synchronous = ${synchronous === 'FULL' ? 'FULL' : 'NORMAL'}`)

  // The whole schema step under one retry, for the same reason: N processes
  // reaching `CREATE … IF NOT EXISTS` on a file none of them has finished
  // creating is the same race, and the reads that decide the migration are
  // refused by the same lock.
  withOpenRetry('could not create the jobs schema', () => {
    migrateUniqueKey(db)
    // Before SCHEMA, not after: SCHEMA declares an index over `owner_id`, and on
    // a jobs table created before that column existed the index is a hard error
    // naming a column the same statement never adds.
    addColumn(db, 'actor_id')
    addColumn(db, 'tenant_id')
    addColumn(db, 'owner_id')
    db.exec(SCHEMA)
  })

  return db
}

/**
 * Add a nullable TEXT column to a jobs table created before it existed.
 *
 * `CREATE TABLE IF NOT EXISTS` leaves an existing table exactly as it was, so
 * without this every dispatch against an old jobs.db fails on an unknown
 * column. Unlike the unique_key rebuild this is a plain ADD COLUMN — nullable
 * with no default, which SQLite appends in place.
 *
 * What NULL means differs per column and both readings are the honest one.
 * `actor_id`: nothing recorded who asked, so the job runs as the app itself.
 * `tenant_id`: nothing recorded which tenant, which is every app that declares
 * no tenancy and every job that is the app's own work.
 * `owner_id`: nothing recorded which process is executing it, so a running row
 * carrying NULL is reclaimed by the first instance that sweeps — the same
 * answer this package gave before owners existed.
 */
function addColumn(db: Database, name: string): void {
  const cols = db.query<{ name: string }, []>(`PRAGMA table_info(jobs)`).all()
  // No table at all — this is a fresh database and SCHEMA creates it with the
  // column already in it.
  if (cols.length === 0) return
  if (cols.some(c => c.name === name)) return
  db.exec(`ALTER TABLE jobs ADD COLUMN ${name} TEXT`)
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
    tenant_id: string | null
  }>(db.prepare(`
    INSERT INTO jobs
      (id, queue, name, data, status, priority, max_attempts, retry_delay, unique_key, run_at, created_at, actor_id, tenant_id)
    VALUES
      ($id, $queue, $name, $data, $status, $priority, $max_attempts, $retry_delay, $unique_key, $run_at, $created_at, $actor_id, $tenant_id)
  `))

  // ── Claim next job (atomic — uses RETURNING to avoid race conditions) ────────
  // SQLite's BEGIN IMMEDIATE ensures only one worker claims a job at a time.

  const claimNext = wrap<JobRecord, { queue: string; now: number; owner: string }>(db.prepare(`
    UPDATE jobs SET
      status     = 'running',
      started_at = $now,
      owner_id   = $owner,
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

  // A process only claims what it can run. The handler set is a fact about
  // this process, so the name list is bound rather than compiled in, and the
  // statement is cached per list SIZE — the shape of the SQL is the only thing
  // that varies. `releaseClaim` above stays the backstop: an autoloaded handler
  // registered between the claim and the execute is still possible.
  const claimCache = new Map<number, WrappedStatement<JobRecord, BindObject>>()
  const claimNextNamed = (count: number) => {
    let stmt = claimCache.get(count)
    if (!stmt) {
      const names = Array.from({ length: count }, (_, i) => `$n${i}`).join(', ')
      stmt = wrap<JobRecord, BindObject>(db.prepare(`
        UPDATE jobs SET
          status     = 'running',
          started_at = $now,
          owner_id   = $owner,
          attempts   = attempts + 1
        WHERE id = (
          SELECT id FROM jobs
          WHERE  queue  = $queue
            AND  status = 'pending'
            AND  run_at <= $now
            AND  name IN (${names})
          ORDER BY priority DESC, run_at ASC
          LIMIT 1
        )
        RETURNING *
      `))
      claimCache.set(count, stmt)
    }
    return stmt
  }

  // ── Mark done ───────────────────────────────────────────────────────────────
  // Guarded on 'running': cancel() can land while the attempt is in flight, and
  // an unguarded UPDATE writes 'done' over the cancellation the caller asked for.
  // `changes` is 0 when that happens — the worker reads it before announcing.
  //
  // Guarded on the OWNER for the same reason across processes: a stalled
  // instance whose lease expired has had its row reclaimed and re-run
  // elsewhere, and its late completion must not land on the attempt that
  // replaced it. `owner_id` is cleared here so a reclaim sweep never has to
  // decide anything about a row that is no longer running.

  const markDone = wrap<void, { id: string; now: number; owner: string }>(db.prepare(`
    UPDATE jobs SET
      status      = 'done',
      finished_at = $now,
      owner_id    = NULL,
      error       = NULL
    WHERE id = $id AND status = 'running' AND owner_id = $owner
  `))

  // ── Mark failed (will retry or transition to terminal 'failed' depending on caller) ─
  // Same guard, and it carries more: without it a cancelled job whose handler
  // then threw is written back to 'pending' and runs again.

  const markFailed = wrap<void, {
    id: string; status: string; run_at: number; error: string; now: number; owner: string
  }>(db.prepare(`
    UPDATE jobs SET
      status      = $status,
      finished_at = $now,
      error       = $error,
      run_at      = $run_at,
      owner_id    = NULL
    WHERE id = $id AND status = 'running' AND owner_id = $owner
  `))

  // ── Release a claim this process cannot execute ─────────────────────────────
  //
  // *I cannot do this* is not *this cannot be done*. A process with no handler
  // for a name used to mark the row terminally failed, so a web process polling
  // beside a worker one — or the old replica of a rolling deploy — destroyed
  // work the process that owns the handler was about to do. The attempt the
  // claim consumed is given back with it.

  const releaseClaim = wrap<void, { id: string; owner: string }>(db.prepare(`
    UPDATE jobs SET
      status     = 'pending',
      started_at = NULL,
      owner_id   = NULL,
      attempts   = MAX(attempts - 1, 0)
    WHERE id = $id AND status = 'running' AND owner_id = $owner
  `))

  // ── Is there anything to claim? ─────────────────────────────────────────────
  //
  // Read-only, so it takes no write lock. `_claim` opened BEGIN IMMEDIATE on
  // every poll of every queue whether or not anything was pending — 3 write
  // transactions a second per replica on one shared file, with nothing to do.

  const anyPending = wrap<{ one: number }, { queue: string; now: number }>(db.prepare(`
    SELECT 1 AS one FROM jobs
    WHERE queue = $queue AND status = 'pending' AND run_at <= $now
    LIMIT 1
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

  // How long the oldest in-flight job on each queue has been in flight.
  //
  // The counting query above cannot see a stall: a queue with one stuck job
  // reports `running: 1` for as long as the process lives, which is what a
  // queue doing steady work also reports (`FJS-295`). A count that never moves
  // says nothing; a count that never moves beside an age climbing past an hour
  // is unmistakable, and no threshold has to be guessed to say it.
  //
  // Asked of the DATABASE rather than an in-process set, so a job another
  // instance is holding is in the answer too — which is the shape a stall
  // actually has in a deployment with two replicas.
  const oldestRunning = db.prepare<
    { queue: string; started_at: number }, []
  >(`
    SELECT queue, MIN(started_at) AS started_at
    FROM   jobs
    WHERE  status = 'running' AND started_at IS NOT NULL
    GROUP  BY queue
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

  // ── Ownership: heartbeat, recovery, pruning ─────────────────────────────────
  //
  // The three statements that make a second instance on one jobs.db safe. A
  // running row is owned; an owner says it is alive on a timer; recovery
  // reclaims only the rows of an owner that has stopped saying so.
  //
  // Two instances is not an exotic deployment — two replicas behind a load
  // balancer, a web process beside a worker one, a drive started while the dev
  // server runs. Before this, `start()` set EVERY running row back to pending,
  // so the second instance re-ran whatever the first was executing, and the
  // claim that IS atomic could not tell: the second run was a legitimate claim
  // of a row that recovery had just released.

  const heartbeat = wrap<void, { id: string; now: number }>(db.prepare(`
    INSERT INTO job_owners (id, started_at, seen_at)
    VALUES ($id, $now, $now)
    ON CONFLICT(id) DO UPDATE SET seen_at = $now
  `))

  // Graceful shutdown. Dropping the row makes this instance's rows reclaimable
  // at once instead of after the lease — the caller only does it once nothing
  // is in flight, so there is no attempt to hand over.
  const dropOwner = wrap<void, { id: string }>(db.prepare(`
    DELETE FROM job_owners WHERE id = $id
  `))

  // A running row is abandoned when its owner is unknown, or last said it was
  // alive before the cutoff. NULL is the pre-owners database and reads the same
  // way: nothing is known to be executing it.
  const reclaimAbandoned = wrap<void, { cutoff: number }>(db.prepare(`
    UPDATE jobs SET
      status     = 'pending',
      started_at = NULL,
      owner_id   = NULL
    WHERE status = 'running'
      AND (owner_id IS NULL
           OR owner_id NOT IN (SELECT id FROM job_owners WHERE seen_at >= $cutoff))
  `))

  const pruneOwners = wrap<void, { cutoff: number }>(db.prepare(`
    DELETE FROM job_owners WHERE seen_at < $cutoff
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
    claimNextNamed,
    markDone,
    markFailed,
    cancel,
    releaseClaim,
    anyPending,
    retryTerminal,
    statsByQueue,
    oldestRunning,
    getById,
    findByUniqueKey,
    listJobs,
    cleanup,
    heartbeat,
    dropOwner,
    reclaimAbandoned,
    pruneOwners,
  }
}

export type Statements = ReturnType<typeof buildStatements>

// ─── Stats aggregation ────────────────────────────────────────────────────────

export function aggregateStats(
  rows:    { queue: string; status: string; count: number }[],
  queues:  string[],
  oldest:  { queue: string; started_at: number }[] = [],
  now:     number = Date.now()
): CaravanStats {
  const zero = (): QueueStats => ({
    pending: 0, running: 0, done: 0, failed: 0, cancelled: 0, oldestRunningMs: null,
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

  // `null` where nothing is running, never 0: a queue with nothing in flight has
  // no age, and 0 would read as *started this instant* on the one line somebody
  // checks to see whether work is moving.
  for (const row of oldest) {
    if (!result.queues[row.queue]) result.queues[row.queue] = zero()
    const age = Math.max(0, now - row.started_at)
    result.queues[row.queue].oldestRunningMs = age
    result.total.oldestRunningMs = result.total.oldestRunningMs == null
      ? age
      : Math.max(result.total.oldestRunningMs, age)
  }

  return result
}
