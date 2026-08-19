// src/worker.ts
// In-process polling worker. One polling loop per queue, each loop
// claiming and executing up to `concurrency` jobs concurrently.

import type { Database } from 'bun:sqlite'
import type { Statements } from './db.ts'
import type { JobContext, RegisteredHandler, QueueConfig, CaravanTelemetry, CaravanApp } from './types.ts'

const DEFAULT_RETRY_DELAY = [60_000, 300_000, 1_800_000] // 1m, 5m, 30m

// ─── Single queue worker ──────────────────────────────────────────────────────

export class QueueWorker {
  readonly queue:       string
  private _concurrency: number
  private _interval:    number
  private _db:          Database
  private _stmts:       Statements
  private _handlers:    Map<string, RegisteredHandler>
  // WHICH instance this worker claims for. Every running row carries it, so
  // another instance's recovery can tell this worker's in-flight job from a
  // crashed process's abandoned one.
  private _owner:       string
  _telemetry:   CaravanTelemetry | null  // set by plugin register()
  _app:         CaravanApp | null = null // set by plugin register(), like _telemetry
  private _timer:       ReturnType<typeof setInterval> | null = null
  private _running:     Set<string> = new Set()   // in-flight job IDs
  private _stopping:    boolean = false
  private _drainTimeout: number
  constructor(
    queue:        string,
    config:       QueueConfig,
    db:           Database,
    stmts:        Statements,
    handlers:     Map<string, RegisteredHandler>,
    pollInterval: number,
    owner:        string,
    telemetry:    CaravanTelemetry | null = null,
    drainTimeout: number = 30_000,
  ) {
    this.queue        = queue
    this._concurrency = config.concurrency ?? 2
    this._interval    = pollInterval
    this._db          = db
    this._stmts       = stmts
    this._handlers    = handlers
    this._telemetry   = telemetry
    this._owner       = owner
    this._drainTimeout = drainTimeout
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
    // Wait for in-flight jobs to finish.
    //
    // A hardcoded 30s is the whole shutdown budget of a deployment whose SIGTERM
    // grace is shorter: one unbounded stuck handler and every stop takes 30s and
    // is then killed mid-drain anyway (`FJS-295`). The bound is the app's to
    // state, and the default is unchanged.
    const deadline = Date.now() + this._drainTimeout
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
      job = this._stmts.claimNext.get({ queue: this.queue, now: Date.now(), owner: this._owner })
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
        owner:  this._owner,
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

    // The handler runs on behalf of whoever asked for the work — the principal
    // recorded at dispatch, re-resolved now rather than replayed from a stored
    // session, so a caller demoted in between is graded at what they hold now.
    // `null` (cron, boot, standalone) is the app's own system principal.
    //
    // Junction's runAs opens an AsyncLocalStorage scope, so a service call
    // inside the handler that names no auth inherits this principal without
    // being handed anything. Standalone, there is no runAs and no principal;
    // the handler is called directly and ctx.auth.user is null.
    const runAs = this._app?.runAs
    const run = async (user: unknown | null) => {
      const ctx: JobContext = {
        id:       record.id,
        queue:    record.queue,
        name:     record.name,
        data,
        attempts: record.attempts,
        actorId:  record.actor_id ?? null,
        auth:     { user: user as JobContext['auth']['user'] },
        // undefined rather than null when there is no app: a handler tests
        // `ctx.app?` and an optional property that is present-but-null reads
        // as a bug in the app wiring rather than as standalone Caravan.
        app:      (this._app ?? undefined) as JobContext['app'],
      }
      await handler.handler(ctx)
    }

    try {
      const invoke = runAs
        ? () => runAs.call(this._app, record.actor_id ?? null, run) as Promise<void>
        : () => run(null)
      await this._bounded(invoke(), handler.timeout, record)
      const doneMs = Date.now()
      // 0 changes means cancel() took the row out of 'running' mid-attempt and
      // the guard held. The outcome is 'cancelled', so announce nothing.
      // 0 changes ALSO means another instance reclaimed this row while the
      // handler ran — the owner guard is what keeps that completion off the
      // attempt that replaced it.
      const { changes } = this._stmts.markDone.run({ id: record.id, now: doneMs, owner: this._owner })
      if (changes > 0) this._telemetry?.emit('caravan.job.done', {
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
        const { changes } = this._stmts.markFailed.run({
          id:     record.id,
          status: 'failed',
          run_at: record.run_at,
          error,
          now:    failedAt,
          owner:  this._owner,
        })
        if (changes > 0) this._telemetry?.emit('caravan.job.failed', {
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

        const { changes } = this._stmts.markFailed.run({
          id:     record.id,
          status: 'pending',
          run_at: runAt,
          error,
          now:    failedAt,
          owner:  this._owner,
        })
        if (changes > 0) this._telemetry?.emit('caravan.job.failed', {
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

  // ── The bound on one attempt ────────────────────────────────────────────────
  //
  // Without a declared timeout this is the promise, unchanged — absent means no
  // bound, honestly, the same contract every declaration here has.
  //
  // With one, the wait is bounded and the attempt fails on the ordinary path:
  // the caller's catch counts it, applies the retry ladder and emits
  // `caravan.job.failed` exactly as a throw would. That uniformity is the point
  // — a timeout is a failure, not a fifth status.
  //
  // WHAT IT CANNOT DO IS STOP THE HANDLER. Nothing in JavaScript cancels a
  // promise, so the abandoned invocation keeps running and may still be writing
  // while the retry runs. Two consequences, both handled here rather than left
  // to chance:
  //
  //   - Its later rejection has no reader once the race is lost, and an
  //     unhandled rejection takes the process down. It is caught below.
  //   - Its later settlement is the single most useful thing a person
  //     debugging this can be told — *the work you gave up on finished after
  //     45 minutes* — so it is announced rather than swallowed silently.
  //
  // A handler that never yields is unreachable from here: the timer needs the
  // event loop. Same ground as the heartbeat in `FJS-294`.
  private _bounded(
    work:    Promise<void>,
    timeout: number | undefined,
    record:  { id: string; queue: string; name: string }
  ): Promise<void> {
    if (!timeout || timeout <= 0) return work

    let timer: ReturnType<typeof setTimeout> | null = null
    let abandoned = false
    const startedAt = Date.now()

    // Attached BEFORE the race, so there is never a tick on which this promise
    // can reject with nobody listening.
    work.then(
      () => { if (abandoned) this._orphanSettled(record, startedAt, null) },
      (err: unknown) => { if (abandoned) this._orphanSettled(record, startedAt, err) },
    )

    const bound = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abandoned = true
        this._telemetry?.emit('caravan.job.timeout', {
          id: record.id, queue: record.queue, name: record.name, timeout,
        })
        reject(new Error(
          `Job '${record.name}' exceeded its ${timeout}ms timeout. The attempt is ` +
          `failed and may retry; the handler was NOT cancelled and may still be running.`
        ))
      }, timeout)
      if (timer.unref) timer.unref()
    })

    return Promise.race([work, bound]).finally(() => { if (timer) clearTimeout(timer) })
  }

  private _orphanSettled(
    record:    { id: string; queue: string; name: string },
    startedAt: number,
    err:       unknown
  ): void {
    const durationMs = Date.now() - startedAt
    this._telemetry?.emit('caravan.job.orphan', {
      id:    record.id,
      queue: record.queue,
      name:  record.name,
      durationMs,
      error: err == null ? null : err instanceof Error ? err.message : String(err),
    })
    // Said out loud as well as emitted: an app with no telemetry wired is
    // exactly the app that will otherwise never learn a timed-out handler ran
    // to completion after its retry had already done the work again.
    console.warn(
      `[Caravan] '${record.name}' (${record.id}) ${err == null ? 'finished' : 'threw'} ` +
      `${durationMs}ms after starting — past its timeout, so the attempt had already ` +
      `been failed. Its effects happened anyway.`
    )
  }
}

// ─── Worker pool — one QueueWorker per named queue ────────────────────────────

export class WorkerPool {
  private _workers: Map<string, QueueWorker> = new Map()

  add(worker: QueueWorker): void {
    this._workers.set(worker.queue, worker)
  }

  /** Is there already a worker for this queue? */
  has(queue: string): boolean {
    return this._workers.has(queue)
  }

  /** Visit every worker — how the plugin backfills `_app` and `_telemetry`. */
  each(fn: (worker: QueueWorker) => void): void {
    for (const w of this._workers.values()) fn(w)
  }

  start(): void {
    for (const w of this._workers.values()) w.start()
  }

  async stop(): Promise<void> {
    await Promise.all([...this._workers.values()].map(w => w.stop()))
  }

  /**
   * Forget every worker. Called after stop() closes the database: a worker
   * holds the Database and its prepared statements, so a restart must build
   * new ones rather than poll through a closed handle.
   */
  clear(): void {
    this._workers.clear()
  }

  get totalInFlight(): number {
    let n = 0
    for (const w of this._workers.values()) n += w.inFlight
    return n
  }
}
