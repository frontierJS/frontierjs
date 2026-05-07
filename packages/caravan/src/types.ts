// src/types.ts
// All shared types for @frontierjs/caravan.

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
}

// ─── Parsed job passed to handlers ───────────────────────────────────────────

export interface Job<T = unknown> {
  id:       string
  queue:    string
  name:     string
  data:     T
  attempts: number
}

// ─── Handler + registration options ──────────────────────────────────────────

export type JobHandler<T = unknown> = (job: Job<T>) => Promise<void> | void

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
}

export interface RegisteredHandler {
  name:        string
  handler:     JobHandler
  queue:       string
  maxAttempts: number
  retryDelay:  number[]
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
   * Deduplication key. If a pending job with this key already exists,
   * the new dispatch is a no-op and returns the existing job's ID.
   * Useful for "only one of these should be queued at a time" patterns.
   */
  unique?:   string
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
  failed:    number
  cancelled: number
}

export interface CaravanStats {
  queues: Record<string, QueueStats>
  total:  QueueStats
}

// ─── Duck-typed Junction app interface ───────────────────────────────────────
// Caravan doesn't import @frontierjs/junction — it shape-matches what it needs.

export interface CaravanApp {
  /** Junction's metrics provider registry — if present, Caravan adds job stats */
  _metricsProviders?: Map<string, () => unknown>
  /** Junction's telemetry bus — if present, Caravan emits job lifecycle events */
  telemetry?: { emit(event: string, data: unknown): void }
  /** Arbitrary property bag — Caravan sets app.jobs here */
  [key: string]: unknown
}

// ─── Public Caravan instance ──────────────────────────────────────────────────

export interface CaravanInstance {
  /**
   * Dispatch a job to the queue.
   * Can be called before start() — jobs are persisted immediately.
   */
  dispatch<T = unknown>(name: string, data: T, opts?: DispatchOptions): Promise<string>

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
   * @param opts.timeZone IANA timezone string — job fires at the right local time
   */
  schedule(name: string, cron: string, handler: JobHandler, opts?: { queue?: string; timeZone?: string }): void

  /** Returns the next scheduled fire time for each registered cron. */
  nextRuns(): Array<{ name: string; cron: string; nextRun: Date | null }>

  // Junction plugin protocol
  name:      string
  register:  (app: CaravanApp) => Promise<void> | void
  boot?:     (app: CaravanApp) => Promise<void> | void
  ready?:    (app: CaravanApp) => Promise<void> | void
  shutdown?: (app: CaravanApp) => Promise<void> | void
}
