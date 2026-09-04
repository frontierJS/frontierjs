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

import { timingSafeEqual } from 'node:crypto'
import { occurrenceKey } from '@frontierjs/toolbelt/history'
import type { Database }                            from 'bun:sqlite'
import { openDb, buildStatements, aggregateStats, reclaimFreePages, isPrimaryKeyCollision, isUniqueKeyCollision } from './db.ts'
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
  let busyTimeout  = opts.busyTimeout  ?? 5_000
  let synchronous  = opts.synchronous  ?? 'NORMAL'
  let pollInterval = opts.pollInterval ?? 1_000
  let drainTimeout = opts.drainTimeout ?? 30_000
  let jobsDir      = opts.jobsDir
  let cleanupAfter = opts.cleanupAfter ?? 7 * 24 * 60 * 60 * 1_000  // 7 days
  let adminOpts    = opts.admin
  let heartbeatMs  = opts.heartbeat ?? 5_000
  let leaseMs      = opts.lease     ?? 30_000

  const queueConf: Record<string, QueueConfig> = {
    default: { concurrency: 2 },
    ...(opts.queues ?? {}),
  }

  // WHO this instance is, for the life of the process. One jobs.db is trivially
  // opened twice, and every running row carries the id of the instance holding
  // it so recovery can reclaim a crashed process's work without touching a live
  // one's (FJS-294).
  const ownerId  = crypto.randomUUID()

  const handlers = new Map<string, RegisteredHandler>()
  const pool     = new WorkerPool()
  const cron     = new CronScheduler()
  let   started  = false
  let   telemetry: CaravanTelemetry | null = null
  let   ownerTimer: ReturnType<typeof setInterval> | null = null
  // Held where ownerTimer is held, for the reason it is: a `const` local to
  // start() cannot be cleared, so the hourly sweep went on firing against a
  // closed handle after stop() and a restart added a second one.
  let   sweepTimer: ReturnType<typeof setInterval> | null = null
  // The cleanup sweep yields between batches, so the hourly timer can fire
  // into a sweep that has not finished.
  let   sweeping = false
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
      const db = openDb(dbPath, busyTimeout, synchronous)
      runtime    = { db, stmts: buildStatements(db) }
      openedPath = dbPath
    }
    return runtime
  }

  // ── Ownership ──────────────────────────────────────────────────────────────
  //
  // The answer to "is this 'running' row being executed by anybody?" — which
  // one process never had to ask and two always do. This instance renews its
  // lease, reclaims the rows of instances whose lease has expired, and forgets
  // the owners themselves once nothing can be holding a row for them.
  //
  // The lease is renewed by a timer, so a handler that BLOCKS the event loop
  // for longer than `lease` stalls its own heartbeat and has its work reclaimed
  // under it. That is the same ground as FJS-295 and the same answer: work that
  // does not yield is work this queue cannot supervise.

  // Every timer callback here catches its own throw. `sweepOwners` used to
  // throw `database is locked` out of a `setInterval`, which is an
  // uncaughtException and a dead process — and the heartbeat it missed on the
  // way out is exactly what makes another instance reclaim this one's running
  // rows. A missed sweep is nothing; a missed sweep that kills the process is
  // the failure.
  const onTimer = (label: string, fn: () => void) => (): void => {
    try { fn() } catch (err) {
      console.warn(`[Caravan] ${label} failed and was skipped:`, (err as Error)?.message ?? err)
    }
  }

  const sweepOwners = (): void => {
    if (!runtime) return
    const { stmts } = rt()
    const now    = Date.now()
    const cutoff = now - leaseMs

    stmts.heartbeat.run({ id: ownerId, now })
    stmts.reclaimAbandoned.run({ cutoff })
    // Pruned at twice the lease, after the reclaim: a dead owner's rows are
    // released by the sweep above, and keeping the owner row one lease longer
    // is what lets `list()` and a person reading the table still see which
    // instance had them.
    stmts.pruneOwners.run({ cutoff: now - leaseMs * 2 })
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
    const worker = new QueueWorker(queue, queueConf[queue], db, stmts, handlers, pollInterval, ownerId, telemetry, drainTimeout)
    worker._app = host
    pool.add(worker)
    worker.start()
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  // ── junction.config.js ────────────────────────────────────────────────────
  //
  // Read at boot(), never at register(): register() runs the moment
  // `app.configure(createCaravan(...))` is called and junction does not load
  // junction.config.js until `start()`, so anything read there is the config as
  // it was BEFORE the file — which is to say, without it (`FJS-416`).

  function applyJunctionConfig(app: CaravanApp): void {
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
        if (opts.busyTimeout  === undefined && junctionCaravan.busyTimeout  !== undefined) busyTimeout  = junctionCaravan.busyTimeout
        if (opts.synchronous  === undefined && junctionCaravan.synchronous  !== undefined) synchronous  = junctionCaravan.synchronous
        if (opts.jobsDir      === undefined && junctionCaravan.jobsDir      !== undefined) jobsDir      = junctionCaravan.jobsDir
        if (opts.cleanupAfter === undefined && junctionCaravan.cleanupAfter !== undefined) cleanupAfter = junctionCaravan.cleanupAfter
        if (opts.pollInterval === undefined && junctionCaravan.pollInterval !== undefined) pollInterval = junctionCaravan.pollInterval
        if (opts.drainTimeout === undefined && junctionCaravan.drainTimeout !== undefined) drainTimeout = junctionCaravan.drainTimeout
        if (opts.admin        === undefined && junctionCaravan.admin        !== undefined) adminOpts    = junctionCaravan.admin
        if (opts.heartbeat    === undefined && junctionCaravan.heartbeat    !== undefined) heartbeatMs  = junctionCaravan.heartbeat
        if (opts.lease        === undefined && junctionCaravan.lease        !== undefined) leaseMs      = junctionCaravan.lease

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
  }

  // What the admin surface may say about a payload. `data` is the caller's own
  // arguments — the string, not a parse — so a redacted row keeps the shape a
  // reader expects and says why the value is not there.
  const redactList = (rows: JobRecord[], withData: boolean): JobRecord[] =>
    withData ? rows : rows.map(r => ({ ...r, data: '[redacted]' }))

  // ── admin routes ──────────────────────────────────────────────────────────
  //
  // Mounted at boot() rather than register(), because whether to mount them at
  // all can come from junction.config.js and that file is not loaded until
  // start() (`FJS-416`). Still early enough: junction's `boot-plugins` phase
  // runs before `service-routes` and before `listen`.

  function mountAdminRoutes(app: CaravanApp): void {
    if (!adminOpts) return

    const adminCfg  = adminOpts === true ? {} : adminOpts
      const basePath  = adminCfg.path ?? '/jobs'
      const secret    = adminCfg.secret
      const authorize = adminCfg.authorize

      // These routes are raw `app.get`/`app.post`, so no `@@gate`, no row
      // policy and no session hook is on the path by construction — and
      // `POST /jobs/run/{name}` executes any registered handler with the app's
      // own standing, while `GET /jobs` returns every payload in plaintext.
      // Unauthenticated in production, that is remote job execution on the
      // public API prefix. Refused rather than served, the way junction's own
      // devtools plugin refuses: an authorizer is what makes it mountable, and
      // `secret` is a dev shortcut that stops being one here.
      if (process.env.NODE_ENV === 'production' && !authorize) {
        console.warn(
          '[Caravan] NODE_ENV=production and no `admin.authorize` configured — ' +
          'admin routes NOT mounted. Pass admin: { authorize: async (ctx) => boolean } to enable ' +
          'them in production; `admin: { secret }` is a development shortcut and is refused here.'
        )
        return
      }

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

      // A byte-by-byte `!==` leaks the shared secret one character at a time to
      // anyone who can time the answer. Compared over equal-length buffers,
      // since timingSafeEqual throws on a length mismatch — which is itself the
      // cheap half of the answer and is given away first.
      const secretMatches = (given: string | undefined): boolean => {
        if (!secret || typeof given !== 'string') return false
        const a = Buffer.from(given)
        const b = Buffer.from(secret)
        if (a.length !== b.length) return false
        return timingSafeEqual(a, b)
      }

      const guard = async (ctx: Record<string, unknown>): Promise<void> => {
        const headers = (ctx.headers ?? {}) as Record<string, string>
        // An authorizer is the app's own answer — its session, its gate — and
        // it is asked first and alone where it exists.
        if (authorize) {
          let ok = false
          try { ok = await authorize(ctx) } catch { ok = false }
          if (!ok) deny(401, 'Unauthorized')
          return
        }
        if (!secret) return
        if (!secretMatches(headers['x-caravan-secret'])) deny(401, 'Unauthorized')
      }

      const appRouter = app as unknown as {
        get(path: string, fn: (ctx: unknown) => unknown): void
        post(path: string, fn: (ctx: unknown) => unknown): void
      }

      // Junction's router uses brace syntax for path params ({id}); an
      // Express-style ':id' parses as a literal static segment and never
      // matches, which 404s every by-id route.
      appRouter.get(basePath, async (ctx: unknown) => {
        const c = ctx as Record<string, unknown>
        await guard(c)
        const q = c.query as Record<string, string> | undefined
        // A payload is whatever a caller passed — a reset token, an address, a
        // provider key — and this list is the one place the whole table is
        // handed over at once. Redacted unless asked for by name.
        // The transport parses a query string, so `?data=1` arrives as the
        // number 1 rather than the string.
        const withData = String(q?.data ?? '') === '1'
        return Response.json(redactList(caravan.list({
          queue:  q?.queue,
          status: q?.status as JobStatus | undefined,
          limit:  q?.limit  ? parseInt(q.limit)  : 50,
          offset: q?.offset ? parseInt(q.offset) : 0,
        }), withData))
      })

      appRouter.get(`${basePath}/schedules`, async (ctx: unknown) => {
        const c = ctx as Record<string, unknown>
        await guard(c)
        return Response.json(caravan.nextRuns())
      })

      appRouter.get(`${basePath}/{id}`, async (ctx: unknown) => {
        const c = ctx as Record<string, unknown>
        await guard(c)
        const id  = (c.route as Record<string, string>)?.id
        const job = caravan.find(id)
        if (!job) deny(404, `Job '${id}' not found`)
        const withData = String((c.query as Record<string, unknown> | undefined)?.data ?? '') === '1'
        return Response.json(redactList([job as JobRecord], withData)[0])
      })

      appRouter.post(`${basePath}/{id}/retry`, async (ctx: unknown) => {
        const c = ctx as Record<string, unknown>
        await guard(c)
        const id = (c.route as Record<string, string>)?.id
        const ok = await caravan.retry(id)
        return Response.json({ ok })
      })

      appRouter.post(`${basePath}/{id}/cancel`, async (ctx: unknown) => {
        const c = ctx as Record<string, unknown>
        await guard(c)
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
        await guard(c)
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
      const id    = dispatchOpts.id ?? crypto.randomUUID()
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

      // A STATED id is a claim of idempotency for all time — the id is the
      // primary key, so the work is already queued or already done. Checked
      // first because that is the cheap answer; the insert below is what
      // settles a race, since two processes can both read nothing here.
      if (dispatchOpts.id && stmts.getById.get({ id })) return id

      // WHO asked. Absent means "whoever is in scope", which is the ordinary
      // case and needs saying nowhere; an explicit `actor: null` means this is
      // the app's own work even though a request started it. Tested with `in`
      // rather than `??` for that reason — the same absent-is-not-null rule the
      // rest of the framework makes about a principal.
      const actorId = 'actor' in dispatchOpts
        ? dispatchOpts.actor ?? null
        : host?.principal?.()?.userId ?? null

      // WHERE, on the same absent-is-not-null rule. A job queued inside a
      // request is for the tenant that asked for it and nothing has to be
      // said; `tenant: null` is work that belongs to no tenant, stated.
      const tenantId = 'tenant' in dispatchOpts
        ? dispatchOpts.tenant ?? null
        : host?.tenant?.() ?? null

      const row = {
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
        tenant_id:    tenantId,
      }

      // The primary key is the only thing that can decide a race between two
      // processes retrying the same stated id, so the collision is caught here
      // rather than prevented above. Without a stated id there is nothing to
      // collide with and the throw is a real failure.
      try {
        stmts.insert.run(row)
      } catch (err) {
        if (dispatchOpts.id && isPrimaryKeyCollision(err)) return id
        // The index decided the race this dispatch lost. Ask it who won: the
        // caller asked for "do not queue this twice", and the answer to that is
        // the id of the job already doing the work, never a 500.
        if (dispatchOpts.unique && isUniqueKeyCollision(err)) {
          const winner = stmts.findByUniqueKey.get({ unique_key: dispatchOpts.unique })
          if (winner) return winner.id
          // Gone terminal between the collision and the read, which frees the
          // key — the partial index covers live jobs only. One more attempt;
          // a second collision is a live job again and answers above.
          try {
            stmts.insert.run(row)
            return id
          } catch (again) {
            if (isUniqueKeyCollision(again)) {
              const other = stmts.findByUniqueKey.get({ unique_key: dispatchOpts.unique })
              if (other) return other.id
            }
            throw again
          }
        }
        throw err
      }

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
            timeout:     def.timeout,
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
        // The queue's default applies to a handler that declares none, and is
        // resolved HERE rather than in the worker so `registrations()` reports
        // the bound that will actually be enforced. A snapshot showing `—` for
        // a job the queue does bound would be a true statement about the
        // handler and a false one about the app.
        timeout:  o.timeout ?? queueConf[queue]?.timeout,
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
          //
          // The id NAMES the fire — this job, this minute — rather than being a
          // fresh uuid, which is what makes a second instance's fire a no-op
          // instead of a second row. The scheduler is in-process and there is
          // no leader, so every instance fires and the primary key is what
          // settles it; a lease-held leader would instead miss fires whenever
          // the lease was between owners. Two clocks agreeing to within a
          // minute is the assumption, and it is the same one cron already
          // makes about firing at the right time at all.
          //
          // Built through `occurrenceKey` because a job name is caller-supplied
          // and this id becomes the jobs table's primary key: interpolated raw,
          // a job called `report:daily` fired at minute 5 and a job called
          // `report` fired at `daily:5` are one key, and one of the two fires
          // silently never runs. Byte-identical for a name without a `:`.
          fn: (fireMinute: number) =>
            caravan.dispatch(name, {}, { queue, actor: null, id: occurrenceKey('cron', name, fireMinute) })
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

    // ── unschedule ────────────────────────────────────────────────────────────
    //
    // Unbinds the clock and leaves the handler registered: a run already queued
    // under this name still has something to execute, and only the schedule
    // stopped being true.

    unschedule(name: string): boolean {
      return cron.remove(name)
    },

    // ── registrations ─────────────────────────────────────────────────────────
    //
    // Every registered handler's DECLARATION, name-sorted — what runs, on which
    // queue, on what schedule, with what retry budget. The handler function is
    // deliberately absent: this answers *what did this app say it would run*,
    // and a closure is not part of that answer.
    //
    // `nextRuns()` below is the other question and covers only the scheduled
    // ones, off a live clock. This one is a fact about the app, so it holds
    // still: two boots of the same code answer identically, which is what lets
    // it be committed and diffed. A schedule that stopped being registered is
    // otherwise invisible — every scheduled job in an app once stopped firing
    // at the first restart with every row still reading `scheduled`
    // (`FJS-327`), and nothing anywhere could have been asked.

    registrations(): ReturnType<CaravanInstance['registrations']> {
      return [...handlers.values()]
        .map(h => ({
          name:        h.name,
          queue:       h.queue,
          cron:        h.cron     ?? null,
          timeZone:    h.timeZone ?? null,
          maxAttempts: h.maxAttempts,
          retryDelay:  [...h.retryDelay],
          timeout:     h.timeout ?? null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    },

    // ── nextRuns ──────────────────────────────────────────────────────────────

    nextRuns(): Array<{ name: string; cron: string; nextRun: Date | null }> {
      return cron.nextRuns()
    },

    // ── stats ────────────────────────────────────────────────────────────────

    // Exact, and linear in the retention window: grouping 1M rows costs ~134ms.
    // Readiness deliberately does not come through here — it needs one number
    // and reads the query that answers it.
    stats(): CaravanStats {
      const { stmts } = rt()
      const rows = stmts.statsByQueue.all() as {
        queue: string; status: string; count: number
      }[]
      const oldest = stmts.oldestRunning.all() as {
        queue: string; started_at: number
      }[]
      return aggregateStats(rows, Object.keys(queueConf), oldest)
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

      // Say this instance is alive BEFORE anything sweeps, so a second instance
      // starting at the same moment cannot read this one as dead.
      stmts.heartbeat.run({ id: ownerId, now: Date.now() })

      // Recover jobs abandoned by a crashed instance — and ONLY those. This
      // used to set every 'running' row back to 'pending', which is correct for
      // one process and catastrophic for two: starting a second instance while
      // the first was executing a job released that row and the second claimed
      // it, running the handler twice, concurrently, with the atomic claim
      // saying nothing because the second claim was legitimate (FJS-294).
      onTimer('owner sweep', sweepOwners)()

      // Heartbeat, recovery and owner pruning are one timer: the sweep is only
      // meaningful relative to a lease this instance is also renewing.
      ownerTimer = setInterval(onTimer('owner sweep', sweepOwners), heartbeatMs)
      if (ownerTimer.unref) ownerTimer.unref()

      // Cleanup sweep — remove old terminal jobs (done/failed/cancelled) on
      // start and every hour
      if (cleanupAfter > 0) {
        // One BATCH per pass, yielding to the event loop between them.
        //
        // The statement deletes up to CLEANUP_BATCH rows; the loop repeats
        // until a pass changes nothing. Both halves are load-bearing. Deleting
        // every expired row in one statement held the write lock for 11.5s over
        // 1M rows, and every dispatch and claim in every process waits on it —
        // but batching without the yield only slices the LOCK, since a
        // synchronous loop still holds this process for the whole sweep.
        const sweep = async (): Promise<void> => {
          // The hourly timer must not start a second sweep over a running one:
          // two loops delete each other's batches, so neither sees an empty
          // pass while the other is still finding rows.
          if (sweeping) return
          sweeping = true
          try {
            let removed = 0
            for (;;) {
              // Re-checked after every yield: stop() may have run since.
              if (!runtime) return
              const { changes } = stmts.cleanup.run({ before: Date.now() - cleanupAfter })
              removed += changes
              if (changes === 0) break
              await new Promise(resolve => setTimeout(resolve, 0))
            }
            if (removed > 0) reclaimFreePages(db)
          } catch (err) {
            console.warn('[Caravan] cleanup sweep failed and was skipped:', (err as Error)?.message ?? err)
          } finally {
            sweeping = false
          }
        }
        void sweep()
        sweepTimer = setInterval(() => void sweep(), 60 * 60 * 1_000)
        if (sweepTimer.unref) sweepTimer.unref()
      }

      // One worker per queue anything has named: opts, the config file, a job
      // file, an earlier dispatch.
      for (const [name, config] of Object.entries(queueConf)) {
        if (pool.has(name)) continue
        const worker = new QueueWorker(name, config, db, stmts, handlers, pollInterval, ownerId, telemetry, drainTimeout)
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
      if (ownerTimer) {
        clearInterval(ownerTimer)
        ownerTimer = null
      }
      if (sweepTimer) {
        clearInterval(sweepTimer)
        sweepTimer = null
      }
      await pool.stop()
      started = false

      // Give this instance's rows back on the way out, so another instance
      // recovers them now rather than a lease from now. Only when nothing is in
      // flight: past its 30s deadline pool.stop() abandons a job whose handler
      // may still be running, and dropping the owner then would invite exactly
      // the double execution the owner exists to prevent — that row waits for
      // the lease, which is the one thing that can decide it.
      if (runtime && pool.totalInFlight === 0) {
        try { runtime.stmts.dropOwner.run({ id: ownerId }) } catch {}
      }

      // Closed BEFORE the handle goes: a handler abandoned past the drain
      // deadline is still running, and its completion write would otherwise
      // reject with `Database has closed` as an unhandled rejection.
      pool.markClosed()
      runtime?.db.close()
      // The database the workers hold is now closed, so they cannot be reused;
      // a start() after this builds fresh ones against a freshly opened db.
      pool.clear()
      runtime    = null
      openedPath = null
    },

    // ── Junction plugin protocol ──────────────────────────────────────────────

    register(app: CaravanApp): void {
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

      // Readiness, for the failure the counts cannot show on their own: a queue
      // holding one stuck job reports `running: 1` for the life of the process,
      // which is what a queue doing steady work reports too (`FJS-295`). The
      // age of the oldest in-flight job is what separates them.
      //
      // Only bounded work is graded. A handler that declared no `timeout` said
      // it has no bound, and failing an app's readiness probe on a long job
      // somebody deliberately left unbounded would take a healthy app out of a
      // load balancer. So the threshold is the LONGEST declared timeout, past
      // which every bounded job should already have been given up on — and a
      // queue where nothing declares one is never unhealthy here.
      if (typeof app.registerHealthCheck === 'function') {
        app.registerHealthCheck('jobs', () => {
          const bounds = caravan.registrations().map(r => r.timeout).filter((t): t is number => t != null)
          if (!bounds.length) return true
          const limit  = Math.max(...bounds)
          // `oldestRunning` and not `stats()`: readiness reads one number and
          // the full aggregate groups every row in the retention window to
          // produce it — 1009ms per probe over 1M rows, for a query that on
          // its own costs nothing, on the endpoint an operator hits BECAUSE
          // something is already wrong.
          const now    = Date.now()
          const oldest = (rt().stmts.oldestRunning.all() as { started_at: number }[])
            .map(r => now - r.started_at)
          return Math.max(0, ...oldest) < limit * 2
        })
      }

    },

    async boot(app: CaravanApp): Promise<void> {
      // The caravan section of junction.config.js is read HERE and not in
      // register(), because register() runs at `app.configure(...)` time and
      // junction does not load that file until `start()`. Every app configures
      // its queue at module scope, so the whole block was unreachable for all
      // of them — except an app that hand-loads the config itself and passes it
      // to createApp, which is what made this look like it worked (`FJS-416`).
      //
      // boot() is the first hook that runs after junction's `load-config`
      // phase, and it is still before `service-routes` and `listen`, so the
      // admin routes this mounts are registered in time to be served.
      applyJunctionConfig(app)
      mountAdminRoutes(app)
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
    timeout:     opts.timeout,
    cron:        opts.cron,
    timeZone:    opts.timeZone,
  }
}
