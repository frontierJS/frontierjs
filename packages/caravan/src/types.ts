// src/types.ts
// All shared types for @frontierjs/caravan.

// Type-only, and the only reference to Junction in the package. It erases at
// compile time, so nothing here imports Junction at runtime — see CaravanApp
// below for why the rest of this file shape-matches instead.
import type { App as JunctionApp, SessionContext } from '@frontierjs/junction'

// ─── Job record (as stored in SQLite) ────────────────────────────────────────

export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'

export interface JobRecord {
  id:           string
  queue:        string
  name:         string
  data:         string        // JSON
  status:       JobStatus
  priority:     number
  attempts:     number
  max_attempts: number
  retry_delay:  string | null // JSON array of ms values
  unique_key:   string | null // deduplication key
  run_at:       number        // unix ms
  started_at:   number | null
  finished_at:  number | null
  error:        string | null
  created_at:   number
  /** Who asked for the work. NULL when nobody did — cron, boot, standalone. */
  actor_id:     string | null
  /**
   * Which Caravan instance is executing the row. Set by the claim and cleared
   * when the row leaves 'running', so it is non-null exactly while somebody is
   * working on it. Recovery reclaims a running row whose owner has stopped
   * heartbeating; without it, a second instance's start() released a row the
   * first was midway through.
   */
  owner_id:     string | null
}

// ─── Parsed job ──────────────────────────────────────────────────────────────

export interface Job<T = unknown> {
  id:       string
  queue:    string
  name:     string
  data:     T
  attempts: number
}

// ─── The context a handler runs in ───────────────────────────────────────────
//
// One argument, and it is a Context in the sense the rest of the framework uses
// the word: per-invocation state available to code running on behalf of a
// caller. The job's own facts, plus the two things a handler cannot get any
// other way — who this work is for, and the app to do it through.
//
// `app` is the half that used to have no answer at all. Junction hands `app` to
// every plugin's `register()` and Caravan kept it, so an autoloaded `*.job.ts`
// had no route to `app.service(…)` — which is the whole reason background work
// exists in a framework that owns its announcements. Apps grew a module holding
// a mutable app reference to get around it.
//
// `auth` is the other. It is informational: the principal is already in scope
// by the time the handler runs, so a service call that names no auth inherits
// it. Reading it is for a handler that wants to branch on who asked, or log it.

export interface JobContext<T = unknown> extends Job<T> {
  /** The principal this work runs on behalf of — re-resolved at run time. */
  auth: { user: SessionContext | null }

  /**
   * The running Junction app. Absent when Caravan runs standalone, which is
   * the one case a handler has to test for.
   *
   * Typed as Junction's own `App` rather than the duck-typed `CaravanApp` the
   * rest of this file uses, because a handler's whole reason to hold it is
   * `app.service('orders').call(…)` — and the shape-matched version answers
   * `unknown` for that. The import is TYPE-ONLY and erases, so the runtime
   * independence the duck-typing exists for is untouched.
   */
  app?: JunctionApp

  /** The id recorded at dispatch. null when nobody asked — cron, boot. */
  actorId: string | null
}

// ─── Handler + registration options ──────────────────────────────────────────

export type JobHandler<T = unknown> = (ctx: JobContext<T>) => Promise<void> | void

export interface HandlerOptions {
  /** Which queue this handler listens on. Default: 'default' */
  queue?:       string
  /** Max attempts before marking failed. Default: 3 */
  maxAttempts?: number
  /**
   * Delay in ms before each retry attempt.
   * Index 0 = delay before attempt 2, index 1 = before attempt 3, etc.
   * If attempts exceed the array length, the last value is reused.
   * Default: [60_000, 300_000, 1_800_000]  (1m, 5m, 30m)
   */
  retryDelay?:  number[]
  /**
   * Standard 5-field cron expression — WHEN this job runs on its own.
   *
   * A registration carrying one is a recurring job: the scheduler dispatches it
   * on the expression, with an empty payload and `actor: null`, onto the queue
   * this same registration names. Declaring it here is what lets a `*.job.ts`
   * file say everything about itself; a job that only ever runs on demand
   * states nothing.
   *
   * The name is a schedule, not a list of them — registering the same name
   * again replaces the schedule rather than adding a second one.
   */
  cron?:        string
  /** IANA timezone the `cron` expression is read in. Default: server TZ. */
  timeZone?:    string
}

export interface RegisteredHandler {
  name:        string
  handler:     JobHandler
  queue:       string
  maxAttempts: number
  retryDelay:  number[]
  cron?:       string
  timeZone?:   string
}

// ─── Job definition — what defineJob() returns ───────────────────────────────
//
// A job file's default export, and the one statement of that job's name. It is
// also a dispatch handle: `dispatch(sendEmail, { to })` names nothing, so a
// name cannot be typo'd at a call site and the payload is typed by the handler
// rather than being `unknown` on both sides.

export interface JobDefinition<T = unknown> {
  /** Marker autoload uses to tell a job file's default export from anything else. */
  __caravanJob: true
  name:         string
  handler:      JobHandler<T>
  queue:        string
  maxAttempts:  number
  retryDelay:   number[]
  cron?:        string
  timeZone?:    string
}

/** What dispatch() addresses — a definition, or the name in one. */
export type JobRef = string | { __caravanJob: true; name: string }

/**
 * The slice of Caravan that autoload registers through.
 *
 * Narrower than `Pick<CaravanInstance, 'handle'>` on purpose: `handle` is
 * overloaded, and an overloaded member forces every stub in a test to
 * implement both signatures to be assignable.
 */
export interface JobRegistrar {
  handle(name: string, handler: JobHandler, opts?: HandlerOptions): void
}

// ─── Dispatch options ─────────────────────────────────────────────────────────

export interface DispatchOptions {
  /** Target queue. Default: 'default' */
  queue?:    string
  /** Delay before the job becomes runnable, in ms. Default: 0 */
  delay?:    number
  /** Higher = picked up sooner within same queue. Default: 0 */
  priority?: number
  /**
   * Deduplication key — a lock on work IN FLIGHT.
   *
   * If a job with this key is pending or running, the dispatch is a no-op and
   * returns that job's id. Once it finishes the key is free again, so the same
   * work can be queued a second time later. Terminal jobs keep their key for
   * inspection.
   *
   * "Only one of these at a time" is what this expresses. It is NOT an
   * idempotency key: it will not stop the same work being done twice on two
   * separate occasions, and a key derived from a row id must not be treated as
   * one — SQLite reuses ids, so `book-courier:4` can name two different orders
   * months apart.
   */
  unique?:   string

  /**
   * Whose behalf this work is on. Default: whoever is in scope at dispatch.
   *
   * Read from `app.principal()`, so a job queued inside a request already runs
   * as the caller who asked for it and nothing has to be said. State it to
   * override — a user id to act for someone else, or `null` for work that is
   * the app's own even though a request happened to start it.
   *
   * An id, not a session: what is stored is who, and the standing is resolved
   * when the job runs. See `App.runAs`.
   */
  actor?:    string | null

  /**
   * The row id to queue this job under. Default: a fresh uuid.
   *
   * Stating one makes the dispatch IDEMPOTENT for all time: the id is the
   * jobs table's primary key, so a second dispatch under the same id queues
   * nothing and returns that id. This is what `unique` is not — `unique` is a
   * lock on work in flight and frees itself the moment the job is terminal.
   *
   * For a caller that already holds a durable id for the work and is retrying
   * a handoff it cannot confirm: junction's outbox relay dispatches under the
   * outbox row's id, so a crash between the queue insert and the delivery mark
   * replays into a no-op instead of doing the work twice.
   *
   * Only state one that is unique to the work itself. Anything reused names
   * a job that already ran, and the dispatch is silently dropped.
   */
  id?:       string
}

// ─── Queue config ─────────────────────────────────────────────────────────────

export interface QueueConfig {
  /** Max concurrent jobs in this queue. Default: 2 */
  concurrency?: number
}

// ─── Plugin options ───────────────────────────────────────────────────────────

export interface CaravanOptions {
  /** Path to the SQLite jobs database. Default: './db/jobs.db' */
  db?:           string
  /**
   * Named queue configuration. The 'default' queue always exists.
   * @example { critical: { concurrency: 5 }, email: { concurrency: 1 } }
   */
  queues?:       Record<string, QueueConfig>
  /** How often the worker polls for new jobs, in ms. Default: 1_000 */
  pollInterval?: number
  /**
   * Directory to autoload *.job.ts files from.
   * Mirrors Junction's autoloadServices pattern.
   */
  jobsDir?:      string
  /**
   * How long to retain terminal jobs (done/failed/cancelled), in ms.
   * Jobs older than this are deleted during the cleanup sweep.
   * Default: 7 days. Set to 0 to disable cleanup.
   */
  cleanupAfter?: number
  /**
   * Mount admin HTTP endpoints when used as a Junction plugin.
   * GET  /jobs, GET /jobs/:id, POST /jobs/:id/retry, POST /jobs/:id/cancel
   * Default: false
   */
  admin?: boolean | { path?: string; secret?: string }

  /**
   * How often this instance says it is alive, in ms. Default: 5_000.
   *
   * The same timer reclaims work abandoned by instances that have stopped
   * saying so, so it is also how quickly a crashed process's jobs come back.
   */
  heartbeat?:    number

  /**
   * How long an instance may go quiet before its running jobs are treated as
   * abandoned and re-queued, in ms. Default: 30_000.
   *
   * Longer than `heartbeat` by enough to survive a slow tick — a lease shorter
   * than a few heartbeats reclaims work from a live instance, which is the
   * double execution this whole mechanism exists to stop. Longer also means a
   * genuinely crashed process's jobs wait longer to be retried; 6 missed
   * heartbeats is the default trade.
   */
  lease?:        number
}

// ─── Cron schedule ────────────────────────────────────────────────────────────

export interface CronEntry {
  name:      string
  cron:      string     // standard 5-field cron expression
  handler:   JobHandler
  queue?:    string
  timeZone?: string     // IANA timezone e.g. 'America/New_York'. Default: server TZ
}

// ─── Queue stats ──────────────────────────────────────────────────────────────

export interface QueueStats {
  pending:   number
  running:   number
  /** Completed, over the retention window — the one number that says work is moving. */
  done:      number
  failed:    number
  cancelled: number
}

export interface CaravanStats {
  queues: Record<string, QueueStats>
  total:  QueueStats
}

// ─── Duck-typed Junction app interface ───────────────────────────────────────
// Caravan doesn't import @frontierjs/junction — it shape-matches what it needs.

/** The slice of Junction's event bus that Caravan emits through. */
export interface CaravanTelemetry {
  emit(event: string, data?: unknown): unknown
}

/**
 * Deliberately NO `[key: string]: unknown` index signature.
 *
 * An index signature here made `CaravanApp` unassignable *from* Junction's
 * `App` (which has none), and because `register(app: CaravanApp)` puts the app
 * in a contravariant position, that made the whole plugin unassignable to
 * Junction's `PluginInput` — so `app.configure(createCaravan())` failed to
 * typecheck for every TypeScript consumer. List the fields Caravan actually
 * touches instead; anything else goes through an explicit cast at the use site.
 */
export interface CaravanApp {
  /** Junction's metrics seam — if present, Caravan contributes job stats */
  registerMetricsSource?: (name: string, fn: () => unknown) => void
  /** Junction's telemetry bus — if present, Caravan emits job lifecycle events */
  telemetry?: CaravanTelemetry
  /** Where Caravan attaches itself — Junction's augmentable `App.jobs` slot */
  jobs?: unknown
  /**
   * Junction's guarded namespace claim. Used when present so a second plugin
   * claiming `app.jobs` fails loudly instead of silently winning; falls back to
   * plain assignment against an older Junction.
   */
  claim?: (name: string, value: unknown) => void
  /** Junction's resolved config — read for an optional `caravan` section */
  config?: unknown

  /**
   * WHO is in scope right now — read at dispatch to record who asked.
   *
   * Optional because Caravan runs standalone, where there is no request and no
   * principal to read. A job dispatched with neither this nor an explicit
   * `actor` records nobody and runs as the app itself.
   */
  principal?: () => { userId?: string } | null

  /**
   * Run the handler on behalf of a principal, re-resolved now.
   *
   * The seam that removes the oldest hazard in this package: a job had no
   * principal, and no principal is STRANGER(0), so a handler writing back
   * through `app.service('x').patch(…)` was refused by the model's own `@@gate`
   * unless every job carried a hand-written `{ auth: { user: SYSTEM } }`.
   *
   * Junction's implementation opens an AsyncLocalStorage scope, so a service
   * call inside the handler that names no auth inherits this principal — the
   * same propagation any nested call gets.
   *
   * Absent (standalone Caravan) means the handler is called directly and
   * `ctx.auth.user` is null. Nothing to be graded by, and nothing pretending.
   */
  runAs?: <T>(userId: string | null, fn: (user: SessionContext | null) => T | Promise<T>) => Promise<T>

  /** Junction's service caller — reached from a handler as `ctx.app.service(…)`. */
  service?: (name: string) => unknown
}

// ─── Public Caravan instance ──────────────────────────────────────────────────

export interface CaravanInstance {
  /**
   * Dispatch a job by its definition — the import IS the name, and `data` is
   * typed by the handler that will receive it.
   *
   * Can be called before start() — jobs are persisted immediately.
   */
  dispatch<T>(job: JobDefinition<T>, data: T, opts?: DispatchOptions): Promise<string>

  /**
   * Dispatch a job by name. Nothing reconciles the string with the handler
   * that answers to it, so a typo is a job no worker ever picks up; prefer the
   * definition where the file can be imported.
   */
  dispatch<T = unknown>(name: string, data: T, opts?: DispatchOptions): Promise<string>

  /** Register a job definition — its own queue, retries and cron. */
  handle<T>(job: JobDefinition<T>): void

  /** Register a handler for a job type. Must be called before start(). */
  handle<T = unknown>(name: string, handler: JobHandler<T>, opts?: HandlerOptions): void

  /** Cancel a job by ID. Works on pending or running jobs. No-op if already terminal. */
  cancel(id: string): Promise<boolean>

  /** Re-queue a failed or cancelled job (resets attempts to 0, clears error). */
  retry(id: string): Promise<boolean>

  /** Current queue statistics. */
  stats(): CaravanStats

  /** Start the worker polling loop. Called automatically when used as a plugin. */
  start(): Promise<void>

  /** Stop the worker loop gracefully — waits for in-flight jobs to finish. */
  stop(): Promise<void>

  /**
   * List recent jobs with optional filters.
   */
  list(opts?: { queue?: string; status?: JobStatus; limit?: number; offset?: number }): JobRecord[]

  /**
   * Get a single job by ID.
   */
  find(id: string): JobRecord | null

  /**
   * Register a recurring cron job.
   * Uses standard 5-field cron syntax: '0 2 * * *' = 2am daily.
   *
   * Sugar over `handle(name, handler, { cron })`, which is the same
   * registration a `*.job.ts` file makes for itself. Reach for this when the
   * handler is not a job file — a closure, or a function imported from
   * somewhere that is not `jobsDir`.
   *
   * @param opts.timeZone IANA timezone string — job fires at the right local time
   */
  schedule(name: string, cron: string, handler: JobHandler, opts?: { queue?: string; timeZone?: string }): void

  /**
   * Stop a schedule firing. Answers whether one was registered under that name.
   *
   * The counterpart `schedule()` did not have, and it is only needed for the
   * schedules that do not come from a `*.job.ts` file: a job file's schedule
   * lives as long as the process, but one registered from a DATABASE ROW stops
   * being true when the row is deleted or stops being a scheduled job. Without
   * this the timer kept firing for the rest of the process, dispatching work
   * for a job nobody could see.
   *
   * The HANDLER stays registered — an in-flight or already-queued run must
   * still find something to execute. This unbinds the clock, nothing else.
   */
  unschedule(name: string): boolean

  /** Returns the next scheduled fire time for each registered cron. */
  nextRuns(): Array<{ name: string; cron: string; nextRun: Date | null }>

  // Junction plugin protocol
  name:      string
  register:  (app: CaravanApp) => Promise<void> | void
  boot?:     (app: CaravanApp) => Promise<void> | void
  ready?:    (app: CaravanApp) => Promise<void> | void
  shutdown?: (app: CaravanApp) => Promise<void> | void
}
