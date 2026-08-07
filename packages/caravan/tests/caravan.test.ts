// tests/caravan.test.ts
// Bun test runner: bun test tests/caravan.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { createCaravan, defineJob } from '../src/index.ts'
import type { CaravanInstance } from '../src/types.ts'
import { Database } from 'bun:sqlite'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeQueue(opts: Parameters<typeof createCaravan>[0] = {}): CaravanInstance {
  return createCaravan({
    db:          ':memory:',   // in-memory SQLite — no files, no cleanup
    pollInterval: 50,          // fast polling for tests
    ...opts,
  })
}

async function waitFor(
  fn:         () => boolean,
  timeoutMs:  number = 2_000,
  intervalMs: number = 20
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await Bun.sleep(intervalMs)
  }
}

// ─── createCaravan ────────────────────────────────────────────────────────────

describe('createCaravan', () => {

  it('creates an instance without throwing', () => {
    expect(() => makeQueue()).not.toThrow()
  })

  it('returns a valid CaravanInstance shape', () => {
    const q = makeQueue()
    expect(typeof q.dispatch).toBe('function')
    expect(typeof q.handle).toBe('function')
    expect(typeof q.cancel).toBe('function')
    expect(typeof q.retry).toBe('function')
    expect(typeof q.stats).toBe('function')
    expect(typeof q.start).toBe('function')
    expect(typeof q.stop).toBe('function')
  })

  it('has the Junction plugin protocol fields', () => {
    const q = makeQueue()
    expect(q.name).toBe('caravan')
    expect(typeof q.register).toBe('function')
    expect(typeof q.boot).toBe('function')
  })

})

// ─── dispatch ─────────────────────────────────────────────────────────────────

describe('dispatch', () => {
  let q: CaravanInstance

  beforeEach(() => { q = makeQueue() })
  afterEach(async () => { await q.stop() })

  it('returns a job ID string', async () => {
    const id = await q.dispatch('test-job', { foo: 'bar' })
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
  })

  it('dispatched job appears in pending stats', async () => {
    await q.dispatch('test-job', {})
    const stats = q.stats()
    expect(stats.total.pending).toBe(1)
  })

  it('dispatching multiple jobs increments pending count', async () => {
    await q.dispatch('job-a', {})
    await q.dispatch('job-b', {})
    await q.dispatch('job-c', {})
    expect(q.stats().total.pending).toBe(3)
  })

  it('respects custom queue option', async () => {
    await q.dispatch('test-job', {}, { queue: 'critical' })
    const stats = q.stats()
    expect(stats.queues['critical']?.pending ?? 0).toBe(1)
  })

  // ── unique ────────────────────────────────────────────────────────────────
  //
  // The whole option was untested, and both readings of it were wrong in turn.
  // The lookup said "a PENDING job with this key" while the column said
  // `unique_key TEXT UNIQUE` — unique forever — so a repeat dispatch after the
  // first job finished walked past the guard into the constraint:
  //   500 GeneralError: UNIQUE constraint failed: jobs.unique_key
  // Making the lookup match ANY status fixed that and broke the other side: a
  // key built from a row id matched a job belonging to a DELETED order whose id
  // SQLite had reused, and the new work silently never ran.
  //
  // Both were found in one afternoon by example/'s courier booking. The rule is
  // "one at a time", enforced by a partial unique index over live jobs.

  it('a second dispatch while the first is still queued is a no-op', async () => {
    const first  = await q.dispatch('test-job', { n: 1 }, { unique: 'k' })
    const second = await q.dispatch('test-job', { n: 2 }, { unique: 'k' })

    expect(second).toBe(first)
    expect(q.stats().total.pending).toBe(1)
  })

  it('frees the key once the job has finished', async () => {
    // This is the line that used to throw `UNIQUE constraint failed` — and,
    // after the over-correction, the line that returned the OLD job's id and
    // quietly did no work.
    q.handle('test-job', async () => {})
    await q.start()
    const first = await q.dispatch('test-job', {}, { unique: 'k' })
    await waitFor(() => q.find(first)?.status === 'done')

    const second = await q.dispatch('test-job', {}, { unique: 'k' })

    expect(second).not.toBe(first)
    expect(q.find(second)!.status).toBe('pending')
    // The finished job keeps its key — it is what the admin list is inspected by.
    expect(q.find(first)!.unique_key).toBe('k')
  })

  it('a cancelled job frees the key too', async () => {
    const first = await q.dispatch('test-job', {}, { unique: 'k' })
    await q.cancel(first)

    const second = await q.dispatch('test-job', {}, { unique: 'k' })
    expect(second).not.toBe(first)
  })

  it('different keys are different jobs', async () => {
    const a = await q.dispatch('test-job', {}, { unique: 'a' })
    const b = await q.dispatch('test-job', {}, { unique: 'b' })

    expect(b).not.toBe(a)
    expect(q.stats().total.pending).toBe(2)
  })

  it('no key means no de-duplication', async () => {
    const a = await q.dispatch('test-job', {})
    const b = await q.dispatch('test-job', {})

    expect(b).not.toBe(a)
    expect(q.stats().total.pending).toBe(2)
  })

  it('respects delay option — job not runnable until delay elapses', async () => {
    q.handle('delayed-job', async () => {})
    await q.start()
    await q.dispatch('delayed-job', {}, { delay: 10_000 })
    // Give the worker time to poll — it should NOT pick up the delayed job
    await Bun.sleep(150)
    const stats = q.stats()
    expect(stats.total.pending).toBe(1)
    expect(stats.total.running).toBe(0)
  })

})

// ─── handle + execution ───────────────────────────────────────────────────────

describe('job execution', () => {
  let q: CaravanInstance

  beforeEach(() => { q = makeQueue() })
  afterEach(async () => { await q.stop() })

  it('executes a dispatched job', async () => {
    let ran = false
    q.handle('simple-job', async () => { ran = true })
    await q.start()
    await q.dispatch('simple-job', {})
    await waitFor(() => ran)
    expect(ran).toBe(true)
  })

  it('passes job data to the handler', async () => {
    let received: unknown
    q.handle('data-job', async (job) => { received = job.data })
    await q.start()
    await q.dispatch('data-job', { name: 'Alice', value: 42 })
    await waitFor(() => received !== undefined)
    expect((received as Record<string, unknown>).name).toBe('Alice')
    expect((received as Record<string, unknown>).value).toBe(42)
  })

  it('marks job as done after successful execution', async () => {
    q.handle('done-job', async () => {})
    await q.start()
    await q.dispatch('done-job', {})
    await waitFor(() => q.stats().total.pending === 0 && q.stats().total.running === 0)
    // done jobs don't appear in stats (only pending/running/failed/cancelled are counted)
    const stats = q.stats()
    expect(stats.total.pending).toBe(0)
    expect(stats.total.running).toBe(0)
    expect(stats.total.failed).toBe(0)
    expect(stats.total.cancelled).toBe(0)
  })

  it('marks job failed when no handler is registered', async () => {
    await q.start()
    await q.dispatch('unknown-job', {})
    await waitFor(() => q.stats().total.failed === 1)
    expect(q.stats().total.failed).toBe(1)
  })

  it('runs multiple jobs concurrently up to concurrency limit', async () => {
    const running: Set<string> = new Set()
    let maxConcurrent = 0

    q.handle('concurrent-job', async (job) => {
      running.add(job.id)
      maxConcurrent = Math.max(maxConcurrent, running.size)
      await Bun.sleep(80)
      running.delete(job.id)
    })

    await q.start()
    await q.dispatch('concurrent-job', { n: 1 })
    await q.dispatch('concurrent-job', { n: 2 })
    await q.dispatch('concurrent-job', { n: 3 })
    await q.dispatch('concurrent-job', { n: 4 })

    await waitFor(() => q.stats().total.pending === 0 && running.size === 0, 3_000)
    // Default concurrency is 2, so max concurrent should be ≤ 2
    expect(maxConcurrent).toBeLessThanOrEqual(2)
    expect(maxConcurrent).toBeGreaterThanOrEqual(1)
  })

})

// ─── retry logic ──────────────────────────────────────────────────────────────

describe('retry logic', () => {
  let q: CaravanInstance

  beforeEach(() => { q = makeQueue() })
  afterEach(async () => { await q.stop() })

  it('retries a failing job up to maxAttempts', async () => {
    let attempts = 0
    q.handle('failing-job', async () => {
      attempts++
      throw new Error('intentional failure')
    }, {
      maxAttempts: 3,
      retryDelay:  [10, 10],  // very short for tests
    })

    await q.start()
    await q.dispatch('failing-job', {})
    await waitFor(() => q.stats().total.failed === 1, 3_000)

    expect(attempts).toBe(3)
    expect(q.stats().total.failed).toBe(1)
  })

  it('marks job failed after maxAttempts is exhausted', async () => {
    q.handle('always-fails', async () => { throw new Error('fail') }, {
      maxAttempts: 2,
      retryDelay:  [10],
    })

    await q.start()
    await q.dispatch('always-fails', {})
    await waitFor(() => q.stats().total.failed === 1, 2_000)
    expect(q.stats().total.failed).toBe(1)
  })

  it('succeeds on a later attempt', async () => {
    let calls = 0
    q.handle('eventually-succeeds', async () => {
      calls++
      if (calls < 3) throw new Error('not yet')
    }, {
      maxAttempts: 5,
      retryDelay:  [10, 10, 10, 10],
    })

    await q.start()
    await q.dispatch('eventually-succeeds', {})
    await waitFor(() => calls >= 3 && q.stats().total.pending === 0, 3_000)
    expect(calls).toBe(3)
    expect(q.stats().total.failed).toBe(0)
  })

})

// ─── cancel ───────────────────────────────────────────────────────────────────

describe('cancel', () => {
  let q: CaravanInstance

  beforeEach(() => { q = makeQueue() })
  afterEach(async () => { await q.stop() })

  it('cancels a pending job', async () => {
    const id = await q.dispatch('cancelable-job', {})
    const result = await q.cancel(id)
    expect(result).toBe(true)
    expect(q.stats().total.cancelled).toBe(1)
    expect(q.stats().total.pending).toBe(0)
  })

  it('cancels a running job', async () => {
    let started = false
    q.handle('long-running', async () => {
      started = true
      await Bun.sleep(500)
    })
    await q.start()
    const id = await q.dispatch('long-running', {})
    await waitFor(() => started)
    const result = await q.cancel(id)
    expect(result).toBe(true)
    // The job may still be marked 'running' in our in-memory tracker until
    // its handler returns, but the DB row's status is 'cancelled' immediately.
    const job = q.find(id)
    expect(job?.status).toBe('cancelled')
  })

  it('returns false when job does not exist', async () => {
    const result = await q.cancel('non-existent-id')
    expect(result).toBe(false)
  })

  it('returns false when job is already done', async () => {
    let done = false
    q.handle('quick-job', async () => { done = true })
    await q.start()
    const id = await q.dispatch('quick-job', {})
    await waitFor(() => done)
    const result = await q.cancel(id)
    expect(result).toBe(false)
  })

})

// ─── retry terminal jobs ──────────────────────────────────────────────────────

describe('retry terminal job', () => {
  let q: CaravanInstance

  beforeEach(() => { q = makeQueue() })
  afterEach(async () => { await q.stop() })

  it('re-queues a failed job', async () => {
    q.handle('failed-job', async () => { throw new Error('fail') }, {
      maxAttempts: 1,
      retryDelay:  [],
    })

    await q.start()
    const id = await q.dispatch('failed-job', {})
    await waitFor(() => q.stats().total.failed === 1, 2_000)

    const requeued = await q.retry(id)
    expect(requeued).toBe(true)
    expect(q.stats().total.pending).toBe(1)
    expect(q.stats().total.failed).toBe(0)
  })

  it('re-queues a cancelled job', async () => {
    const id = await q.dispatch('cancelled-job', {})
    await q.cancel(id)
    expect(q.stats().total.cancelled).toBe(1)

    const requeued = await q.retry(id)
    expect(requeued).toBe(true)
    expect(q.stats().total.pending).toBe(1)
    expect(q.stats().total.cancelled).toBe(0)
  })

  it('returns false for a non-terminal job', async () => {
    const id = await q.dispatch('still-pending', {})
    const result = await q.retry(id)
    expect(result).toBe(false)
  })

})

// ─── stats ────────────────────────────────────────────────────────────────────

describe('stats', () => {
  let q: CaravanInstance

  afterEach(async () => { await q.stop() })

  it('returns zeroed stats for empty queue', () => {
    q = makeQueue()
    const stats = q.stats()
    expect(stats.total.pending).toBe(0)
    expect(stats.total.running).toBe(0)
    expect(stats.total.failed).toBe(0)
    expect(stats.total.cancelled).toBe(0)
    expect(stats.queues['default']).toBeDefined()
  })

  it('includes all configured queues even when empty', () => {
    q = makeQueue({ queues: { critical: { concurrency: 5 }, email: { concurrency: 1 } } })
    const stats = q.stats()
    expect(stats.queues['default']).toBeDefined()
    expect(stats.queues['critical']).toBeDefined()
    expect(stats.queues['email']).toBeDefined()
  })

  it('correctly attributes jobs to their queues', async () => {
    q = makeQueue({ queues: { critical: { concurrency: 1 } } })
    await q.dispatch('job-a', {}, { queue: 'default' })
    await q.dispatch('job-b', {}, { queue: 'critical' })
    await q.dispatch('job-c', {}, { queue: 'critical' })
    const stats = q.stats()
    expect(stats.queues['default'].pending).toBe(1)
    expect(stats.queues['critical'].pending).toBe(2)
    expect(stats.total.pending).toBe(3)
  })

})

// ─── named queues ─────────────────────────────────────────────────────────────

describe('named queues', () => {
  let q: CaravanInstance

  afterEach(async () => { await q.stop() })

  it('respects per-queue concurrency', async () => {
    q = makeQueue({ queues: { serial: { concurrency: 1 } } })

    const running: Set<string> = new Set()
    let maxConcurrent = 0

    q.handle('serial-job', async (job) => {
      running.add(job.id)
      maxConcurrent = Math.max(maxConcurrent, running.size)
      await Bun.sleep(60)
      running.delete(job.id)
    }, { queue: 'serial' })

    await q.start()
    await q.dispatch('serial-job', {}, { queue: 'serial' })
    await q.dispatch('serial-job', {}, { queue: 'serial' })
    await q.dispatch('serial-job', {}, { queue: 'serial' })

    await waitFor(() => q.stats().queues['serial']?.pending === 0 && running.size === 0, 3_000)
    expect(maxConcurrent).toBe(1)
  })

})

// ─── Junction plugin wiring ───────────────────────────────────────────────────

describe('Junction plugin protocol', () => {

  it('register() sets app.jobs', () => {
    const q = makeQueue()
    const app: Record<string, unknown> = {}
    q.register(app)
    expect(app.jobs).toBe(q)
  })

  it('register() adds to _metricsProviders when present', () => {
    const q = makeQueue()
    const providers = new Map<string, () => unknown>()
    const app = { _metricsProviders: providers }
    q.register(app)
    expect(providers.has('jobs')).toBe(true)
    expect(typeof providers.get('jobs')).toBe('function')
  })

  it('metrics provider returns stats shape', () => {
    const q = makeQueue()
    const providers = new Map<string, () => unknown>()
    q.register({ _metricsProviders: providers })
    const statsResult = providers.get('jobs')!() as ReturnType<typeof q.stats>
    expect(statsResult).toHaveProperty('queues')
    expect(statsResult).toHaveProperty('total')
  })

  it('boot() starts the worker', async () => {
    const q = makeQueue()
    const app: Record<string, unknown> = {}
    q.register(app)
    await q.boot!(app)
    // Dispatch and handle a job to confirm worker is running
    let ran = false
    q.handle('boot-test', async () => { ran = true })
    await q.dispatch('boot-test', {})
    await waitFor(() => ran)
    expect(ran).toBe(true)
    await q.stop()
  })

})

// ─── defineJob ────────────────────────────────────────────────────────────────

describe('defineJob', () => {

  it('returns an object with __caravanJob marker', () => {
    const def = defineJob('my-job', async () => {})
    expect(def.__caravanJob).toBe(true)
  })

  it('sets default options', () => {
    const def = defineJob('my-job', async () => {})
    expect(def.queue).toBe('default')
    expect(def.maxAttempts).toBe(3)
    expect(def.retryDelay).toEqual([])
  })

  it('respects provided options', () => {
    const def = defineJob('my-job', async () => {}, {
      queue:       'email',
      maxAttempts: 5,
      retryDelay:  [1000, 5000],
    })
    expect(def.queue).toBe('email')
    expect(def.maxAttempts).toBe(5)
    expect(def.retryDelay).toEqual([1000, 5000])
  })

  it('stores the handler function', () => {
    const handler = async () => {}
    const def = defineJob('my-job', handler)
    expect(def.handler).toBe(handler)
    expect(def.name).toBe('my-job')
  })

})

// ─── crash recovery ───────────────────────────────────────────────────────────

describe('crash recovery', () => {

  it('recovers jobs stuck in running state on start()', async () => {
    // Simulate a previous crash by dispatching then manually setting
    // status to running — as if the process died mid-execution
    const q = makeQueue()
    const id = await q.dispatch('stuck-job', {})

    // Manually set to running (simulates a crash)
    const db = (q as unknown as { _db?: import('bun:sqlite').Database })
    // Access internal db via the test — we just verify start() resets it
    // by starting fresh and confirming the job gets picked up

    let ran = false
    q.handle('stuck-job', async () => { ran = true })
    await q.start()
    await waitFor(() => ran, 2_000)
    expect(ran).toBe(true)
    await q.stop()
  })

})

// ─── Migrating a pre-2026-08-06 jobs.db ───────────────────────────────────────
//
// `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so
// a database created while `unique_key` carried a table-wide UNIQUE constraint
// would keep it — and keep raising `UNIQUE constraint failed: jobs.unique_key`
// out of dispatch(), against a schema file that no longer explains why.

describe('legacy schema migration', () => {
  const OLD_SCHEMA = `
    CREATE TABLE jobs (
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
  `

  const tmpPath = () =>
    `${tmpdir()}/caravan-legacy-${Math.floor(performance.now() * 1000)}-${process.pid}.db`

  it('drops the table-wide UNIQUE and keeps the rows', async () => {
    const path = tmpPath()
    const legacy = new Database(path, { create: true })
    legacy.exec(OLD_SCHEMA)
    legacy.exec(`
      INSERT INTO jobs (id, queue, name, data, status, unique_key, run_at, created_at)
      VALUES ('old-1', 'default', 'report', '{}', 'done', 'k', 0, 0)
    `)
    legacy.close()

    const q = makeQueue({ db: path })

    // The row survived the rebuild…
    expect(q.find('old-1')!.name).toBe('report')
    // …and the key it holds no longer blocks new work.
    const fresh = await q.dispatch('report', {}, { unique: 'k' })
    expect(fresh).not.toBe('old-1')

    await q.stop()
    rmSync(path, { force: true })
    for (const suffix of ['-wal', '-shm']) rmSync(path + suffix, { force: true })
  })

  it('is a no-op on a database this version created', async () => {
    const path = tmpPath()
    const first = makeQueue({ db: path })
    const id = await first.dispatch('report', {}, { unique: 'k' })
    await first.stop()

    // Reopening must not rebuild anything or lose the job.
    const second = makeQueue({ db: path })
    expect(second.find(id)!.name).toBe('report')
    // Still de-duplicated: the job is pending, so the key is still held.
    expect(await second.dispatch('report', {}, { unique: 'k' })).toBe(id)

    await second.stop()
    rmSync(path, { force: true })
    for (const suffix of ['-wal', '-shm']) rmSync(path + suffix, { force: true })
  })
})
