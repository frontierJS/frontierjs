// plugins/outbox/index.ts
// outbox() — the relay that makes `ctx.enqueue` mean anything.
//
// `ctx.enqueue(job, payload)` writes a row inside the call's own transaction;
// this moves that row into `app.jobs` and marks it delivered. Two things drive
// it and they answer different questions:
//
//   • the kick after a call commits — latency, the ordinary case
//   • the timer — recovery, the case the outbox exists for: a process that
//     died between the commit and the handoff left rows nobody is coming back
//     for, and only a sweep over the table can find them
//
// Installed as a plugin rather than always-on because the relay is a clock and
// a claim on rows: an app with no durable effects should not have either.
// `requires: ['caravan']` — the row's destination is the queue, and an app
// without one would collect rows forever with nothing to deliver them to.

import type { App, Plugin }  from '../../core/app.ts'
import { deliverOutbox, sweepOutbox, outboxCounts, outboxPass, assertOutboxShape,
         hasOutboxModel, OUTBOX_MODEL, DEFAULT_MAX_ATTEMPTS,
         DEFAULT_RETRY_BACKOFF_MS } from '../../core/outbox.ts'
import type { OutboxApi, OutboxCounts, DeliverOptions, DeliverResult } from '../../core/outbox.ts'

export interface OutboxPluginOptions {
  /**
   * How often the recovery sweep runs, in ms. Default 5000.
   *
   * This is not the latency of an ordinary effect — a committed call kicks the
   * relay immediately, against the one database it wrote the row through. It
   * is how long a row left behind by a CRASH waits.
   *
   * Under `strategy database` that distinction is the whole cost model: the
   * kick is one query, and this is one cold open per tenant per tick — 54 ms
   * for 20 tenants, measured. An app with hundreds of them raises this, and
   * pays for it only in how long a crashed process's rows sit.
   */
  intervalMs?:     number
  /** Rows per pass. Default 50. */
  batch?:          number
  /**
   * A claim older than this is retaken, in ms. Default 30000.
   *
   * The window a died-mid-handoff row is stuck for. Too short and two relays
   * fight over a row that is merely slow; the dispatch is idempotent under the
   * row's id, so the cost of being wrong here is a wasted pass, not duplicate
   * work.
   */
  claimTimeoutMs?: number
  /**
   * How long a delivered row is kept, in ms. Default 7 days. 0 keeps forever.
   *
   * They are kept at all because "was this effect ever queued, and when" is the
   * question asked after something did not arrive.
   */
  retentionMs?:    number
  /**
   * How many attempts a row gets before it is DEAD. Default 10; `0` never
   * gives up, which is what this did before there was a number.
   *
   * A row past the cap is not deleted and not marked: it stays with its
   * `lastError`, stops matching the relay's query, and is counted as `dead`
   * rather than `pending`. Dead is DERIVED from `attempts`, so raising this
   * number revives every row it now covers — which is the way back for a poison
   * row whose handler has since been fixed.
   */
  maxAttempts?:    number
  /**
   * The first retry delay, in ms, doubling per attempt and capped at an hour.
   * Default 5000.
   *
   * Without one a failed row was retried on every tick of the relay's clock
   * forever, so a queue that is refusing was asked twelve times a minute for
   * as long as the process ran.
   */
  retryBackoffMs?: number
}

export function outbox(opts: OutboxPluginOptions = {}): Plugin {
  const intervalMs     = opts.intervalMs     ?? 5_000
  const batch          = opts.batch          ?? 50
  const claimTimeoutMs = opts.claimTimeoutMs ?? 30_000
  const retentionMs    = opts.retentionMs    ?? 7 * 24 * 60 * 60 * 1_000
  const maxAttempts    = opts.maxAttempts    ?? DEFAULT_MAX_ATTEMPTS
  const retryBackoffMs = opts.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS

  /** What every entry point into core/outbox.ts is graded by. */
  const policy: DeliverOptions = { batch, claimTimeoutMs, maxAttempts, retryBackoffMs }

  let timer:   ReturnType<typeof setInterval> | null = null
  let running = false
  // The timer runs the API's own pass rather than reaching for `app.outbox`:
  // `claim()` refuses to overwrite, so on a second relay over one table that
  // property is the FIRST relay's and this one's clock would drive it.
  let api:     OutboxApi | null = null

  // What /metrics answers. Counters are cumulative since boot and cover BOTH
  // drivers — the timer and the post-commit kick — because `deliver` below is
  // the one place either goes through.
  //
  // `pending` is a COUNT and therefore a query, so it is refreshed once per
  // pass rather than once per scrape: a metrics endpoint that runs a query per
  // request is a load amplifier pointed at your own database. It is the number
  // as of `lastPassAt`, which is what makes that field worth having beside it.
  let delivered  = 0
  let failed     = 0
  let pending    = 0
  let dead       = 0
  let lastPassAt: string | null = null

  return {
    name:     'outbox',
    requires: ['caravan'],

    register(app: App): void {
      api = {
        async deliver(o: DeliverOptions = {}): Promise<DeliverResult> {
          const result = await deliverOutbox(app, { ...policy, ...o })
          delivered += result.delivered
          failed    += result.failed
          return result
        },

        sweep: (ms = retentionMs): Promise<number> =>
          ms > 0 ? sweepOutbox(app, ms) : Promise.resolve(0),

        // Every database the relay sweeps, summed — under
        // `strategy database` the rows are one file per tenant, and a count of
        // the app's own would have answered 0 for all of them.
        pending: async (): Promise<number> => (await outboxCounts(app, policy)).pending,
        counts:  (): Promise<OutboxCounts> => outboxCounts(app, policy),

        // ONE walk of the databases. Deliver, sweep and count used to be three
        // calls and each resolved the registry itself, so a tenanted app
        // opened every tenant three times per tick.
        async pass(): Promise<DeliverResult & OutboxCounts> {
          const result = await outboxPass(app, policy, retentionMs)
          delivered += result.delivered
          failed    += result.failed
          pending    = result.pending
          dead       = result.dead
          lastPassAt = new Date().toISOString()
          return result
        },
      }

      // claim() refuses to overwrite, which is what stops two relays over one
      // table from both thinking they own it.
      if (typeof app.claim === 'function') app.claim('outbox', api)
      else (app as { outbox?: OutboxApi }).outbox = api

      // *How many effects are owed* is the first question asked when something
      // did not arrive, and until this there was no way to ask it without
      // opening the database. Contributed rather than mounted as a route, for
      // the reason `FJS-D06` gives: `/metrics` has one owner.
      //
      // A source must be SYNCHRONOUS — `/metrics` assigns `fn()` straight into
      // the body, so a promise would serialize as `{}`.
      if (typeof app.registerMetricsSource === 'function')
        app.registerMetricsSource('outbox', () => ({ pending, dead, delivered, failed, lastPassAt }))

      // A relay that has stopped passing is an app that still answers every
      // request and quietly owes an unbounded number of effects, which is
      // exactly what a readiness probe is for. Graded against the interval the
      // app configured rather than a number chosen here — three missed passes,
      // so a slow pass is not an outage. Silent until the first pass runs,
      // because *not started yet* is not *stuck*.
      //
      // A DEAD row fails it too, and that is the only thing here that reports a
      // problem with the work rather than with the relay: an effect that has
      // been given up on is owed and is never going to happen, which nothing
      // else in this process will ever say out loud.
      if (typeof app.registerHealthCheck === 'function')
        app.registerHealthCheck('outbox', () =>
          dead === 0 &&
          (lastPassAt === null || Date.now() - Date.parse(lastPassAt) < intervalMs * 3))
    },

    async boot(app: App): Promise<void> {
      // Named at boot rather than discovered at the first enqueue: an app that
      // configured the relay and never ran the install has a schema that can
      // hold no rows, and the first sign of it would otherwise be a service
      // call failing in production.
      //
      // A tenanted app is asked of its tenants instead: `createApp({ tenants })`
      // sets no `app.db` at all, so grading the app-level client would refuse
      // every database-per-tenant app that has the model in every file it
      // matters in.
      const tenanted = !!(app as { tenants?: unknown }).tenants
      if (!tenanted && !hasOutboxModel(app.db))
        throw new Error(
          `[Junction] outbox(): this schema declares no ${OUTBOX_MODEL}. ` +
          `Run 'fli outbox:install' to import db/outbox.lite, or drop app.configure(outbox()).`
        )

      // Which databases hold rows, asked where the answer can still refuse:
      // `pass()` logs and continues, so an app built with both a db and a
      // tenant registry would drain half its rows behind one log line.
      await assertOutboxShape(app)

      // One pass before the first tick: whatever the last process left behind
      // is owed now, not in intervalMs.
      await pass(app)

      timer = setInterval(() => { void pass(app) }, intervalMs)
      // A relay is not a reason for the process to stay alive.
      if (timer.unref) timer.unref()
    },

    async shutdown(): Promise<void> {
      if (timer) { clearInterval(timer); timer = null }
    },
  }

  /**
   * One tick. Overlap is refused rather than queued: a pass slower than the
   * interval would otherwise stack up passes that all fight for the same rows,
   * and every one of them loses the compare-and-set except the first.
   */
  async function pass(app: App): Promise<void> {
    if (running) return
    running = true
    try {
      await api!.pass()
    } catch (err) {
      app.logger?.error?.('[Junction] outbox relay pass failed', {
        error: (err as Error)?.message,
      })
    } finally {
      running = false
    }
  }
}
