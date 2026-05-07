// src/worker.ts
// In-process polling worker. One polling loop per queue, each loop
// claiming and executing up to `concurrency` jobs concurrently.

import type { Database } from 'bun:sqlite'
import type { Statements } from './db.ts'
import type { Job, RegisteredHandler, QueueConfig } from './types.ts'

const DEFAULT_RETRY_DELAY = [60_000, 300_000, 1_800_000] // 1m, 5m, 30m

// ─── Single queue worker ──────────────────────────────────────────────────────

export class QueueWorker {
  readonly queue:       string
  private _concurrency: number
  private _interval:    number
  private _db:          Database
  private _stmts:       Statements
  private _handlers:    Map<string, RegisteredHandler>
  _telemetry:   { emit(event: string, data: unknown): void } | null  // set by plugin register()
  private _timer:       ReturnType<typeof setInterval> | null = null
  private _running:     Set<string> = new Set()   // in-flight job IDs
  private _stopping:    boolean = false

  constructor(
    queue:        string,
    config:       QueueConfig,
    db:           Database,
    stmts:        Statements,
    handlers:     Map<string, RegisteredHandler>,
    pollInterval: number,
    telemetry:    { emit(event: string, data: unknown): void } | null = null,
  ) {
    this.queue        = queue
    this._concurrency = config.concurrency ?? 2
    this._interval    = pollInterval
    this._db          = db
    this._stmts       = stmts
    this._handlers    = handlers
    this._telemetry   = telemetry
  }

  start(): void {
    if (this._timer) return
    this._stopping = false
    // Stagger queue start times slightly to reduce lock contention
    const jitter = Math.floor(Math.random() * 200)
    setTimeout(() => {
      this._timer = setInterval(() => this._poll(), this._interval)
      if (this._timer.unref) this._timer.unref()
      // Run immediately without waiting for first interval
      this._poll()
    }, jitter)
  }

  async stop(): Promise<void> {
    this._stopping = true
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
    // Wait for in-flight jobs to finish
    const deadline = Date.now() + 30_000
    while (this._running.size > 0 && Date.now() < deadline) {
      await Bun.sleep(100)
    }
  }

  get inFlight(): number {
    return this._running.size
  }

  // ── Poll for work ───────────────────────────────────────────────────────────

  private _poll(): void {
    if (this._stopping) return
    const available = this._concurrency - this._running.size
    if (available <= 0) return

    for (let i = 0; i < available; i++) {
      const job = this._claim()
      if (!job) break
      this._execute(job)   // intentionally not awaited — fire and track
    }
  }

  private _claim() {
    // BEGIN IMMEDIATE ensures atomic claim even with multiple in-process pollers
    let job: ReturnType<typeof this._stmts.claimNext.get> = null

    try {
      this._db.exec('BEGIN IMMEDIATE')
      job = this._stmts.claimNext.get({ queue: this.queue, now: Date.now() })
      this._db.exec('COMMIT')
    } catch (err) {
      try { this._db.exec('ROLLBACK') } catch {}
      // Busy lock is expected under concurrency — not an error
      return null
    }

    return job ?? null
  }

  // ── Execute a claimed job ───────────────────────────────────────────────────

  private async _execute(record: NonNullable<ReturnType<typeof this._stmts.claimNext.get>>): Promise<void> {
    this._running.add(record.id)

    const handler = this._handlers.get(record.name)

    if (!handler) {
      // No handler registered — mark failed immediately (no retries possible)
      this._stmts.markFailed.run({
        id:     record.id,
        status: 'failed',
        run_at: record.run_at,
        error:  `No handler registered for job '${record.name}'`,
        now:    Date.now(),
      })
      this._running.delete(record.id)
      return
    }

    const startMs = Date.now()
    this._telemetry?.emit('caravan.job.start', {
      id:    record.id,
      queue: record.queue,
      name:  record.name,
    })

    let data: unknown
    try {
      data = JSON.parse(record.data)
    } catch {
      data = {}
    }

    const job: Job = {
      id:       record.id,
      queue:    record.queue,
      name:     record.name,
      data,
      attempts: record.attempts,
    }

    try {
      await handler.handler(job)
      const doneMs = Date.now()
      this._stmts.markDone.run({ id: record.id, now: doneMs })
      this._telemetry?.emit('caravan.job.done', {
        id:         record.id,
        queue:      record.queue,
        name:       record.name,
        durationMs: doneMs - startMs,
      })
    } catch (err) {
      const error   = err instanceof Error ? err.message : String(err)
      const max     = handler.maxAttempts
      const attempt = record.attempts  // already incremented by claimNext

      const failedAt = Date.now()
      if (attempt >= max) {
        // Out of retries — mark failed (terminal)
        this._stmts.markFailed.run({
          id:     record.id,
          status: 'failed',
          run_at: record.run_at,
          error,
          now:    failedAt,
        })
        this._telemetry?.emit('caravan.job.failed', {
          id:         record.id,
          queue:      record.queue,
          name:       record.name,
          error,
          attempts:   attempt,
          status:     'failed',
          durationMs: failedAt - startMs,
        })
      } else {
        // Schedule retry with configured or default delay
        const delays = handler.retryDelay.length > 0
          ? handler.retryDelay
          : DEFAULT_RETRY_DELAY

        const delayMs = delays[Math.min(attempt - 1, delays.length - 1)]
        const runAt   = failedAt + delayMs

        this._stmts.markFailed.run({
          id:     record.id,
          status: 'pending',
          run_at: runAt,
          error,
          now:    failedAt,
        })
        this._telemetry?.emit('caravan.job.failed', {
          id:         record.id,
          queue:      record.queue,
          name:       record.name,
          error,
          attempts:   attempt,
          status:     'pending',
          retryAt:    runAt,
          durationMs: failedAt - startMs,
        })
      }
    } finally {
      this._running.delete(record.id)
    }
  }
}

// ─── Worker pool — one QueueWorker per named queue ────────────────────────────

export class WorkerPool {
  private _workers: Map<string, QueueWorker> = new Map()

  add(worker: QueueWorker): void {
    this._workers.set(worker.queue, worker)
  }

  start(): void {
    for (const w of this._workers.values()) w.start()
  }

  async stop(): Promise<void> {
    await Promise.all([...this._workers.values()].map(w => w.stop()))
  }

  get totalInFlight(): number {
    let n = 0
    for (const w of this._workers.values()) n += w.inFlight
    return n
  }
}
