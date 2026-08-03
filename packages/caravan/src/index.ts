// src/index.ts
// @frontierjs/caravan — SQLite-backed job queue for Bun.
//
// Standalone usage:
//   const queue = createCaravan({ queues: { email: { concurrency: 1 } } })
//   queue.handle('send-email', async (job) => { ... })
//   await queue.start()
//   await queue.dispatch('send-email', { to: 'alice@example.com' })
//
// As a Junction plugin:
//   app.configure(createCaravan({ jobsDir: './jobs' }))
//   await app.jobs.dispatch('send-email', { to: 'alice@example.com' })

import { openDb, buildStatements, aggregateStats } from './db.ts'
import { QueueWorker, WorkerPool }                  from './worker.ts'
import { autoloadJobs }                             from './autoload.ts'
import { CronScheduler, nextFireTime }              from './cron.ts'
import type {
  CaravanOptions, CaravanInstance, CaravanApp, CaravanTelemetry,
  CaravanStats, DispatchOptions, HandlerOptions,
  JobHandler, JobRecord, JobStatus, RegisteredHandler,
} from './types.ts'

export type {
  CaravanOptions, CaravanInstance, CaravanStats,
  Job, JobHandler, HandlerOptions, DispatchOptions,
  JobRecord, JobStatus, QueueConfig, QueueStats,
  CronEntry,
} from './types.ts'

// Contribute the real type of `app.jobs` to Junction's augmentable slot.
// Augment the interface — never redeclare `App.jobs` — see the AppConduit
// note in the repo CLAUDE.md: a redeclaration silently loses (TS2717) and
// `app.jobs` resolves to `{}` at every call site.
declare module '@frontierjs/junction' {
  interface AppJobs extends CaravanInstance {}
}

// ─── createCaravan ────────────────────────────────────────────────────────────

export function createCaravan(opts: CaravanOptions = {}): CaravanInstance {
  const dbPath       = opts.db           ?? './db/jobs.db'
  const pollInterval = opts.pollInterval ?? 1_000
  const queueConf    = { default: { concurrency: 2 }, ...(opts.queues ?? {}) }
  let   jobsDir      = opts.jobsDir
  let   cleanupAfter = opts.cleanupAfter ?? 7 * 24 * 60 * 60 * 1_000  // 7 days
  const adminOpts    = opts.admin

  const db       = openDb(dbPath)
  const stmts    = buildStatements(db)
  const handlers = new Map<string, RegisteredHandler>()
  const pool     = new WorkerPool()
  const cron     = new CronScheduler()
  let   started  = false
  let   telemetry: CaravanTelemetry | null = null

  // Build a worker for each configured queue
  for (const [name, config] of Object.entries(queueConf)) {
    pool.add(new QueueWorker(name, config, db, stmts, handlers, pollInterval, telemetry))
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  const caravan: CaravanInstance = {

    name: 'caravan',

    // ── dispatch ─────────────────────────────────────────────────────────────

    async dispatch<T = unknown>(
      name: string,
      data: T,
      dispatchOpts: DispatchOptions = {}
    ): Promise<string> {
      const id    = crypto.randomUUID()
      const delay = dispatchOpts.delay    ?? 0
      const prio  = dispatchOpts.priority ?? 0
      const now   = Date.now()

      // If a handler is registered with a specific queue for this name,
      // respect that over the dispatch-time queue
      const registered = handlers.get(name)
      const targetQueue = dispatchOpts.queue ?? registered?.queue ?? 'default'

      // Auto-create a worker for unknown queues dispatched at runtime
      if (!pool['_workers'].has(targetQueue)) {
        const worker = new QueueWorker(
          targetQueue,
          { concurrency: 2 },
          db, stmts, handlers, pollInterval, telemetry
        )
        pool.add(worker)
        if (started) worker.start()
      }

      // Deduplication — if a pending job with this unique key exists, return its id
      if (dispatchOpts.unique) {
        const existing = stmts.findByUniqueKey.get({ unique_key: dispatchOpts.unique })
        if (existing) return existing.id
      }

      stmts.insert.run({
        id,
        queue:        targetQueue,
        name,
        data:         JSON.stringify(data),
        status:       'pending',
        priority:     prio,
        max_attempts: registered?.maxAttempts ?? 3,
        retry_delay:  registered?.retryDelay
          ? JSON.stringify(registered.retryDelay)
          : null,
        unique_key:   dispatchOpts.unique ?? null,
        run_at:       now + delay,
        created_at:   now,
      })

      return id
    },

    // ── handle ───────────────────────────────────────────────────────────────

    handle<T = unknown>(
      name:         string,
      handler:      JobHandler<T>,
      handlerOpts:  HandlerOptions = {}
    ): void {
      const queue       = handlerOpts.queue       ?? 'default'
      const maxAttempts = handlerOpts.maxAttempts ?? 3
      const retryDelay  = handlerOpts.retryDelay  ?? []

      handlers.set(name, {
        name,
        handler:     handler as JobHandler,
        queue,
        maxAttempts,
        retryDelay,
      })

      // Auto-create a worker if this handler targets a queue we don't have yet
      if (!pool['_workers'].has(queue)) {
        const worker = new QueueWorker(
          queue,
          { concurrency: 2 },
          db, stmts, handlers, pollInterval, telemetry
        )
        pool.add(worker)
        if (started) worker.start()
      }
    },

    // ── cancel ───────────────────────────────────────────────────────────────

    async cancel(id: string): Promise<boolean> {
      const result = stmts.cancel.run({ id, now: Date.now() })
      return result.changes > 0
    },

    // ── retry ────────────────────────────────────────────────────────────────

    async retry(id: string): Promise<boolean> {
      const result = stmts.retryTerminal.run({ id, now: Date.now() })
      return result.changes > 0
    },

    // ── list ─────────────────────────────────────────────────────────────────

    list(listOpts: {
      queue?:  string
      status?: JobStatus
      limit?:  number
      offset?: number
    } = {}): JobRecord[] {
      return stmts.listJobs.all({
        queue:  listOpts.queue  ?? null,
        status: listOpts.status ?? null,
        limit:  listOpts.limit  ?? 50,
        offset: listOpts.offset ?? 0,
      }) as JobRecord[]
    },

    // ── find ─────────────────────────────────────────────────────────────────

    find(id: string): JobRecord | null {
      return (stmts.getById.get({ id }) as JobRecord | null) ?? null
    },

    // ── schedule (cron) ───────────────────────────────────────────────────────

    schedule(
      name:      string,
      cronExpr:  string,
      handler:   JobHandler,
      schedOpts: { queue?: string; timeZone?: string } = {}
    ): void {
      cron.add({
        name,
        cron:      cronExpr,
        timeZone:  schedOpts.timeZone,
        fn:        () => caravan.dispatch(name, {}, { queue: schedOpts.queue ?? 'default' })
          .catch(err => console.error(`[Caravan] Cron dispatch "${name}" failed:`, err)),
      })

      // Register the handler so workers can process it
      if (!handlers.has(name)) {
        caravan.handle(name, handler, { queue: schedOpts.queue ?? 'default' })
      }
    },

    // ── nextRuns ──────────────────────────────────────────────────────────────

    nextRuns(): Array<{ name: string; cron: string; nextRun: Date | null }> {
      return cron.nextRuns()
    },

    // ── stats ────────────────────────────────────────────────────────────────

    stats(): CaravanStats {
      const rows = stmts.statsByQueue.all() as {
        queue: string; status: string; count: number
      }[]
      return aggregateStats(rows, Object.keys(queueConf))
    },

    // ── start ────────────────────────────────────────────────────────────────

    async start(): Promise<void> {
      if (started) return
      started = true

      // Autoload job files if a directory is configured
      if (jobsDir) {
        const loaded = await autoloadJobs(jobsDir, caravan)
        if (loaded.length > 0) {
          console.log(`[Caravan] Loaded ${loaded.length} job handler${loaded.length > 1 ? 's' : ''}: ${loaded.join(', ')}`)
        }
      }

      // Recover any jobs stuck in 'running' from a previous crash
      db.exec(`
        UPDATE jobs
        SET status = 'pending', started_at = NULL
        WHERE status = 'running'
      `)

      // Cleanup sweep — remove old terminal jobs (done/failed/cancelled) on
      // start and every hour
      if (cleanupAfter > 0) {
        const sweep = () => stmts.cleanup.run({ before: Date.now() - cleanupAfter })
        sweep()
        const sweepTimer = setInterval(sweep, 60 * 60 * 1_000)
        if (sweepTimer.unref) sweepTimer.unref()
      }

      pool.start()
      cron.start()
    },

    // ── stop ─────────────────────────────────────────────────────────────────

    async stop(): Promise<void> {
      cron.stop()
      await pool.stop()
      started = false
      db.close()
    },

    // ── Junction plugin protocol ──────────────────────────────────────────────

    register(app: CaravanApp): void {
      // If junction.config.js has a caravan section, apply values not already
      // set by opts (opts always wins — explicit beats config file)
      const junctionCaravan = (app as {
        config?: { _junction?: { caravan?: Partial<CaravanOptions> } }
      }).config?._junction?.caravan

      if (junctionCaravan) {
        if (!opts.jobsDir      && junctionCaravan.jobsDir)      jobsDir      = junctionCaravan.jobsDir
        if (!opts.cleanupAfter && junctionCaravan.cleanupAfter) cleanupAfter = junctionCaravan.cleanupAfter
      }

      // Expose caravan instance on app.jobs. provide() refuses to overwrite an
      // existing claim — two plugins owning one name used to be last-write-wins,
      // and the loser just stopped working with no error anywhere.
      if (typeof app.provide === 'function') app.provide('jobs', caravan)
      else app.jobs = caravan

      // Wire Junction telemetry — job lifecycle events flow to devtools feed
      if (app.telemetry) {
        telemetry = app.telemetry
        // Backfill telemetry ref on workers already created before plugin boot
        for (const worker of (pool as unknown as { _workers: Map<string, { _telemetry: typeof telemetry }> })._workers.values()) {
          worker._telemetry = telemetry
        }
      }

      // Wire into Junction's /metrics if available
      if (app._metricsProviders instanceof Map) {
        app._metricsProviders.set('jobs', () => caravan.stats())
      }

      // Admin HTTP endpoints — opt-in via opts.admin
      if (adminOpts) {
        const adminCfg  = adminOpts === true ? {} : adminOpts
        const basePath  = adminCfg.path ?? '/jobs'
        const secret    = adminCfg.secret

        // These are raw app.get/app.post routes, so ctx is Junction's
        // TransportContext: headers live on ctx.headers (lowercased by the
        // transport), NOT nested under ctx.params — params is path params only.
        //
        // Throwing an error that CARRIES its status. Junction's error boundary
        // reads a numeric `status`/`statusCode`/`code` off any thrown value, so
        // this maps to a real 401 without Caravan importing anything from
        // Junction. (It used to return a hand-built Response, because the
        // boundary only understood Junction's own error classes and a thrown
        // `{ code: 401 }` surfaced as a 500.)
        const deny = (status: number, message: string): never => {
          throw Object.assign(new Error(message), { status })
        }

        const guard = (ctx: Record<string, unknown>): void => {
          if (!secret) return
          const headers = (ctx.headers ?? {}) as Record<string, string>
          if (headers['x-caravan-secret'] !== secret) deny(401, 'Unauthorized')
        }

        const appRouter = app as unknown as {
          get(path: string, fn: (ctx: unknown) => unknown): void
          post(path: string, fn: (ctx: unknown) => unknown): void
        }

        // Junction's router uses brace syntax for path params ({id}); an
        // Express-style ':id' parses as a literal static segment and never
        // matches, which 404s every by-id route.
        appRouter.get(basePath, (ctx: unknown) => {
          const c = ctx as Record<string, unknown>
          guard(c)
          const q = c.query as Record<string, string> | undefined
          return Response.json(caravan.list({
            queue:  q?.queue,
            status: q?.status as JobStatus | undefined,
            limit:  q?.limit  ? parseInt(q.limit)  : 50,
            offset: q?.offset ? parseInt(q.offset) : 0,
          }))
        })

        appRouter.get(`${basePath}/schedules`, (ctx: unknown) => {
          const c = ctx as Record<string, unknown>
          guard(c)
          return Response.json(caravan.nextRuns())
        })

        appRouter.get(`${basePath}/{id}`, (ctx: unknown) => {
          const c = ctx as Record<string, unknown>
          guard(c)
          const id  = (c.params as Record<string, string>)?.id
          const job = caravan.find(id)
          if (!job) deny(404, `Job '${id}' not found`)
          return Response.json(job)
        })

        appRouter.post(`${basePath}/{id}/retry`, async (ctx: unknown) => {
          const c = ctx as Record<string, unknown>
          guard(c)
          const id = (c.params as Record<string, string>)?.id
          const ok = await caravan.retry(id)
          return Response.json({ ok })
        })

        appRouter.post(`${basePath}/{id}/cancel`, async (ctx: unknown) => {
          const c = ctx as Record<string, unknown>
          guard(c)
          const id = (c.params as Record<string, string>)?.id
          const ok = await caravan.cancel(id)
          return Response.json({ ok })
        })
      }
    },

    async boot(_app: CaravanApp): Promise<void> {
      await caravan.start()
    },

    async ready(_app: CaravanApp): Promise<void> {
      // No-op — startup happens in boot()
    },

    async shutdown(_app: CaravanApp): Promise<void> {
      await caravan.stop()
    },
  }

  return caravan
}

// ─── defineJob ────────────────────────────────────────────────────────────────
// Used in *.job.ts files for autoloading.
// The __caravanJob marker lets autoload.ts identify valid exports.

export function defineJob<T = unknown>(
  name:    string,
  handler: JobHandler<T>,
  opts:    HandlerOptions = {}
): RegisteredHandler & { __caravanJob: true } {
  return {
    __caravanJob: true as const,
    name,
    handler:     handler as JobHandler,
    queue:       opts.queue       ?? 'default',
    maxAttempts: opts.maxAttempts ?? 3,
    retryDelay:  opts.retryDelay  ?? [],
  }
}
