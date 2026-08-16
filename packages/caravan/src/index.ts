// src/index.ts
// @frontierjs/caravan — SQLite-backed job queue for Bun.
//
// Standalone usage:
//   const queue = createCaravan({ queues: { email: { concurrency: 1 } } })
//   queue.handle('send-email', async (ctx) => { ... })
//   await queue.start()
//   await queue.dispatch('send-email', { to: 'alice@example.com' })
//
// As a Junction plugin:
//   app.configure(createCaravan({ jobsDir: './jobs' }))
//   await app.jobs.dispatch('send-email', { to: 'alice@example.com' })
//
// A handler then reaches the app as `ctx.app` and runs as whoever dispatched
// the job — see JobContext in types.ts.

import type { Database }                            from 'bun:sqlite'
import { openDb, buildStatements, aggregateStats }  from './db.ts'
import type { Statements }                          from './db.ts'
import { QueueWorker, WorkerPool }                  from './worker.ts'
import { autoloadJobs }                             from './autoload.ts'
import { CronScheduler }                            from './cron.ts'
import type {
  CaravanOptions, CaravanInstance, CaravanApp, CaravanTelemetry,
  CaravanStats, DispatchOptions, HandlerOptions,
  JobDefinition, JobHandler, JobRecord, JobRef, JobStatus,
  QueueConfig, RegisteredHandler,
} from './types.ts'

export type {
  CaravanOptions, CaravanInstance, CaravanStats,
  Job, JobContext, JobDefinition, JobHandler, JobRef, JobRegistrar,
  HandlerOptions, DispatchOptions,
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
  // Every option is held in a `let` and read at the moment it is first needed.
  // register() may still change it: the caravan section of junction.config.js
  // does not exist until an app hands it over, and opening the database and
  // building the workers in this function is exactly what made `db`,
  // `pollInterval`, `queues` and `admin` unsettable from a config file at all.
  let dbPath       = opts.db           ?? './db/jobs.db'
  let pollInterval = opts.pollInterval ?? 1_000
  let jobsDir      = opts.jobsDir
  let cleanupAfter = opts.cleanupAfter ?? 7 * 24 * 60 * 60 * 1_000  // 7 days
  let adminOpts    = opts.admin

  const queueConf: Record<string, QueueConfig> = {
    default: { concurrency: 2 },
    ...(opts.queues ?? {}),
  }

  const handlers = new Map<string, RegisteredHandler>()
  const pool     = new WorkerPool()
  const cron     = new CronScheduler()
  let   started  = false
  let   telemetry: CaravanTelemetry | null = null
  // The running app, or null standalone. Held so dispatch can read who is in
  // scope and the worker can open a scope to run the handler in.
  let   host: CaravanApp | null = null

  // ── The database, opened on first use ──────────────────────────────────────
  //
  // Nothing but a queue operation needs it, and every one of those happens
  // after register(): a plugin is configured before it is booted, and a
  // standalone queue has no config to wait for. `openedPath` is what the config
  // merge reads to tell a caller their path arrived too late, rather than
  // silently running against a different file than the one they named.

  let runtime:    { db: Database; stmts: Statements } | null = null
  let openedPath: string | null = null

  const rt = (): { db: Database; stmts: Statements } => {
    if (!runtime) {
      const db = openDb(dbPath)
      runtime    = { db, stmts: buildStatements(db) }
      openedPath = dbPath
    }
    return runtime
  }

  // ── Queues ─────────────────────────────────────────────────────────────────
  //
  // A queue is a NAME until the pool is running. Workers are built in start(),
  // after autoload, so a queue a job file or a config file names still gets
  // one; a queue named for the first time after that (a runtime dispatch, a
  // late handle()) gets its worker immediately.

  const ensureQueue = (queue: string): void => {
    if (!queueConf[queue]) queueConf[queue] = { concurrency: 2 }
    if (!started || pool.has(queue)) return

    const { db, stmts } = rt()
    const worker = new QueueWorker(queue, queueConf[queue], db, stmts, handlers, pollInterval, telemetry)
    worker._app = host
    pool.add(worker)
    worker.start()
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  const caravan: CaravanInstance = {

    name: 'caravan',

    // ── dispatch ─────────────────────────────────────────────────────────────

    async dispatch(
      job:  JobRef,
      data: unknown,
      dispatchOpts: DispatchOptions = {}
    ): Promise<string> {
      // A definition carries the one statement of its own name; a string is the
      // caller restating it. Both end up as the same row.
      const name  = typeof job === 'string' ? job : job.name
      const id    = crypto.randomUUID()
      const delay = dispatchOpts.delay    ?? 0
      const prio  = dispatchOpts.priority ?? 0
      const now   = Date.now()

      const { stmts } = rt()

      // If a handler is registered with a specific queue for this name,
      // respect that over the dispatch-time queue
      const registered  = handlers.get(name)
      const targetQueue = dispatchOpts.queue ?? registered?.queue ?? 'default'

      ensureQueue(targetQueue)

      // Deduplication — if a pending job with this unique key exists, return its id
      if (dispatchOpts.unique) {
        const existing = stmts.findByUniqueKey.get({ unique_key: dispatchOpts.unique })
        if (existing) return existing.id
      }

      // WHO asked. Absent means "whoever is in scope", which is the ordinary
      // case and needs saying nowhere; an explicit `actor: null` means this is
      // the app's own work even though a request started it. Tested with `in`
      // rather than `??` for that reason — the same absent-is-not-null rule the
      // rest of the framework makes about a principal.
      const actorId = 'actor' in dispatchOpts
        ? dispatchOpts.actor ?? null
        : host?.principal?.()?.userId ?? null

      stmts.insert.run({
        id,
        queue:        targetQueue,
        name,
        // An absent payload is an empty one. `JSON.stringify(undefined)` is
        // undefined, which bound as NULL and surfaced as
        // `NOT NULL constraint failed: jobs.data` — a SQLite message naming
        // neither the job nor the caller. `null` is left alone: it is a value
        // somebody passed, and it round-trips.
        data:         JSON.stringify(data === undefined ? {} : data),
        status:       'pending',
        priority:     prio,
        max_attempts: registered?.maxAttempts ?? 3,
        retry_delay:  registered?.retryDelay
          ? JSON.stringify(registered.retryDelay)
          : null,
        unique_key:   dispatchOpts.unique ?? null,
        run_at:       now + delay,
        created_at:   now,
        actor_id:     actorId,
      })

      return id
    },

    // ── handle ───────────────────────────────────────────────────────────────

    handle(
      nameOrJob:   string | JobDefinition<never>,
      handler?:    JobHandler<never>,
      handlerOpts: HandlerOptions = {}
    ): void {
      // A definition already states everything a registration needs, so the
      // two forms differ only in where the values are read from.
      const def  = typeof nameOrJob === 'string' ? null : nameOrJob
      const name = typeof nameOrJob === 'string' ? nameOrJob : nameOrJob.name
      const fn   = (def ? def.handler : handler) as JobHandler | undefined
      const o    = def
        ? {
            queue:       def.queue,
            maxAttempts: def.maxAttempts,
            retryDelay:  def.retryDelay,
            cron:        def.cron,
            timeZone:    def.timeZone,
          }
        : handlerOpts

      if (typeof fn !== 'function')
        throw new Error(`[Caravan] handle('${name}') was given no handler function`)

      const queue       = o.queue       ?? 'default'
      const maxAttempts = o.maxAttempts ?? 3
      const retryDelay  = o.retryDelay  ?? []

      handlers.set(name, {
        name,
        handler:  fn,
        queue,
        maxAttempts,
        retryDelay,
        cron:     o.cron,
        timeZone: o.timeZone,
      })

      // WHEN it runs is declared beside WHAT it does. The schedule is
      // registered here rather than in schedule() because handle() is the only
      // call autoload makes — a job file that could not reach this could
      // declare everything about itself except when it runs.
      if (o.cron) {
        cron.add({
          name,
          cron:     o.cron,
          timeZone: o.timeZone,
          // `actor: null` stated rather than inferred: a cron fire is the app's
          // own work by definition, and nothing about a timer should depend on
          // whether some unrelated request happened to be in scope when it fired.
          fn: () => caravan.dispatch(name, {}, { queue, actor: null })
            .catch(err => console.error(`[Caravan] Cron dispatch "${name}" failed:`, err)),
        })
      }

      ensureQueue(queue)
    },

    // ── cancel ───────────────────────────────────────────────────────────────

    async cancel(id: string): Promise<boolean> {
      const result = rt().stmts.cancel.run({ id, now: Date.now() })
      return result.changes > 0
    },

    // ── retry ────────────────────────────────────────────────────────────────

    async retry(id: string): Promise<boolean> {
      const result = rt().stmts.retryTerminal.run({ id, now: Date.now() })
      return result.changes > 0
    },

    // ── list ─────────────────────────────────────────────────────────────────

    list(listOpts: {
      queue?:  string
      status?: JobStatus
      limit?:  number
      offset?: number
    } = {}): JobRecord[] {
      return rt().stmts.listJobs.all({
        queue:  listOpts.queue  ?? null,
        status: listOpts.status ?? null,
        limit:  listOpts.limit  ?? 50,
        offset: listOpts.offset ?? 0,
      }) as JobRecord[]
    },

    // ── find ─────────────────────────────────────────────────────────────────

    find(id: string): JobRecord | null {
      return (rt().stmts.getById.get({ id }) as JobRecord | null) ?? null
    },

    // ── schedule (cron) ───────────────────────────────────────────────────────
    //
    // Sugar over handle(), so a recurring job registered here and one declared
    // in its own file are the same registration — there is no second place a
    // schedule can come from.

    schedule(
      name:      string,
      cronExpr:  string,
      handler:   JobHandler,
      schedOpts: { queue?: string; timeZone?: string } = {}
    ): void {
      caravan.handle(name, handler, {
        queue:    schedOpts.queue,
        timeZone: schedOpts.timeZone,
        cron:     cronExpr,
      })
    },

    // ── nextRuns ──────────────────────────────────────────────────────────────

    nextRuns(): Array<{ name: string; cron: string; nextRun: Date | null }> {
      return cron.nextRuns()
    },

    // ── stats ────────────────────────────────────────────────────────────────

    stats(): CaravanStats {
      const rows = rt().stmts.statsByQueue.all() as {
        queue: string; status: string; count: number
      }[]
      return aggregateStats(rows, Object.keys(queueConf))
    },

    // ── start ────────────────────────────────────────────────────────────────

    async start(): Promise<void> {
      if (started) return

      const { db, stmts } = rt()

      // Autoload job files FIRST. A job file names its own queue and may
      // declare its own cron, and both have to be known before the workers are
      // built and the scheduler starts. `started` is still false here, so
      // handle() records the queue name rather than building a worker per file.
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

      // One worker per queue anything has named: opts, the config file, a job
      // file, an earlier dispatch.
      for (const [name, config] of Object.entries(queueConf)) {
        if (pool.has(name)) continue
        const worker = new QueueWorker(name, config, db, stmts, handlers, pollInterval, telemetry)
        worker._app = host
        pool.add(worker)
      }

      started = true
      pool.start()
      cron.start()
    },

    // ── stop ─────────────────────────────────────────────────────────────────

    async stop(): Promise<void> {
      cron.stop()
      await pool.stop()
      started = false
      runtime?.db.close()
      // The database the workers hold is now closed, so they cannot be reused;
      // a start() after this builds fresh ones against a freshly opened db.
      pool.clear()
      runtime    = null
      openedPath = null
    },

    // ── Junction plugin protocol ──────────────────────────────────────────────

    register(app: CaravanApp): void {
      // The caravan section of junction.config.js. Every key is honoured, and
      // opts always wins — explicit beats config file. Absent is not a value:
      // the tests are `=== undefined`, so `cleanupAfter: 0` from a config file
      // disables the sweep rather than reading as "unset" (`admin: false` the
      // same way).
      const junctionCaravan = (app as {
        config?: { _junction?: { caravan?: Partial<CaravanOptions> } }
      }).config?._junction?.caravan

      if (junctionCaravan) {
        if (opts.db           === undefined && junctionCaravan.db           !== undefined) dbPath       = junctionCaravan.db
        if (opts.jobsDir      === undefined && junctionCaravan.jobsDir      !== undefined) jobsDir      = junctionCaravan.jobsDir
        if (opts.cleanupAfter === undefined && junctionCaravan.cleanupAfter !== undefined) cleanupAfter = junctionCaravan.cleanupAfter
        if (opts.pollInterval === undefined && junctionCaravan.pollInterval !== undefined) pollInterval = junctionCaravan.pollInterval
        if (opts.admin        === undefined && junctionCaravan.admin        !== undefined) adminOpts    = junctionCaravan.admin

        // Per queue rather than wholesale: a queue named in both places keeps
        // the opts config, a queue only the file names is added.
        for (const [name, config] of Object.entries(junctionCaravan.queues ?? {})) {
          if (!opts.queues?.[name]) queueConf[name] = config
        }

        // The database opens on first use, which is normally after this. A
        // dispatch before configure() opens it at the default path, and a
        // config file naming a different one can no longer take effect — say so
        // rather than run against a file the app did not name.
        if (openedPath && openedPath !== dbPath) {
          console.warn(
            `[Caravan] jobs database was already opened at '${openedPath}', so the configured '${dbPath}' is not in use — ` +
            `something dispatched or read the queue before app.configure(createCaravan(…))`
          )
          dbPath = openedPath
        }
      }

      // Expose caravan instance on app.jobs. claim() refuses to overwrite an
      // existing claim — two plugins owning one name used to be last-write-wins,
      // and the loser just stopped working with no error anywhere.
      if (typeof app.claim === 'function') app.claim('jobs', caravan)
      else app.jobs = caravan

      // The app itself, held for the two things a job needs it for: reading who
      // is in scope at dispatch, and opening a scope to run the handler in.
      // Workers are normally built later, in start(), and read `host` then; the
      // backfill covers a queue that a dispatch before configure() built.
      host = app
      pool.each(worker => { worker._app = app })

      // Wire Junction telemetry — job lifecycle events flow to devtools feed
      if (app.telemetry) {
        telemetry = app.telemetry
        pool.each(worker => { worker._telemetry = telemetry })
      }

      // Wire into Junction's /metrics if available. Optional because Caravan
      // runs standalone against a host that is not a Junction app at all.
      if (typeof app.registerMetricsSource === 'function') {
        app.registerMetricsSource('jobs', () => caravan.stats())
      }

      // Admin HTTP endpoints — opt-in via opts.admin
      if (adminOpts) {
        const adminCfg  = adminOpts === true ? {} : adminOpts
        const basePath  = adminCfg.path ?? '/jobs'
        const secret    = adminCfg.secret

        // These are raw app.get/app.post routes, so ctx is Junction's
        // TransportContext: headers live on ctx.headers (lowercased by the
        // transport), NOT nested under ctx.route — route is path captures only.
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
          const id  = (c.route as Record<string, string>)?.id
          const job = caravan.find(id)
          if (!job) deny(404, `Job '${id}' not found`)
          return Response.json(job)
        })

        appRouter.post(`${basePath}/{id}/retry`, async (ctx: unknown) => {
          const c = ctx as Record<string, unknown>
          guard(c)
          const id = (c.route as Record<string, string>)?.id
          const ok = await caravan.retry(id)
          return Response.json({ ok })
        })

        appRouter.post(`${basePath}/{id}/cancel`, async (ctx: unknown) => {
          const c = ctx as Record<string, unknown>
          guard(c)
          const id = (c.route as Record<string, string>)?.id
          const ok = await caravan.cancel(id)
          return Response.json({ ok })
        })

        // Run a registered job NOW, by name.
        //
        // The admin surface could retry a job and cancel a job but not START
        // one, so the only way to exercise a nightly sweep was to wait until
        // 03:00 — which means a cron handler's behaviour is untestable and, in
        // an incident, unrunnable. "Run the sweep now" is the ops verb this was
        // missing.
        //
        // POSTed to a NAME, not an id: an id is a job that already exists.
        // The body, if any, becomes the job's data — the same shape dispatch()
        // takes — so a scheduled handler that reads a parameter can be given a
        // different one by hand. Refuses an unregistered name rather than
        // queueing a job no worker will ever pick up.
        appRouter.post(`${basePath}/run/{name}`, async (ctx: unknown) => {
          const c = ctx as Record<string, unknown>
          guard(c)
          const name = (c.route as Record<string, string>)?.name
          if (!handlers.has(name))
            deny(404, `No handler registered for '${name}'`)

          // TransportContext.body is already parsed by the transport — there is
          // no request to read here, and awaiting one would hang.
          const data = (c.body && typeof c.body === 'object') ? c.body : {}

          const id = await caravan.dispatch(name, data)
          return Response.json({ ok: true, id })
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
//
// Used in *.job.ts files for autoloading. The __caravanJob marker lets
// autoload.ts identify valid exports, and the NAME must match the file it is
// in — autoload refuses a mismatch rather than registering one name while every
// dispatch says another.
//
// The result is also the dispatch handle. `dispatch(sendEmail, { to })` states
// the name nowhere and types the payload from this handler, where a bare string
// is stated again at every call site and carries `unknown` on both sides.
//
//   export default defineJob('nightly-sweep', sweep, { cron: '0 3 * * *' })
//
// A job that declares `cron` needs nothing in app.ts: WHEN it runs is part of
// the declaration, next to WHAT it does.

export function defineJob<T = unknown>(
  name:    string,
  handler: JobHandler<T>,
  opts:    HandlerOptions = {}
): JobDefinition<T> {
  return {
    __caravanJob: true as const,
    name,
    handler,
    queue:       opts.queue       ?? 'default',
    maxAttempts: opts.maxAttempts ?? 3,
    retryDelay:  opts.retryDelay  ?? [],
    cron:        opts.cron,
    timeZone:    opts.timeZone,
  }
}
