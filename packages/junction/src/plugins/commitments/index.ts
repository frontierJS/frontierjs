// plugins/commitments/index.ts
// commitments() — the clock under `@@commitment` (`FJS-D353`, `FJS-D358`).
//
// Litestone declares a commitment and answers *which rows owe this transition
// by T* (`db.<model>.due()`), but it has no clock and may not dispatch; Caravan
// has the clock and reads no schema. This is the seam between them, and it is
// ONE sweep over every declaration rather than a job per declaration:
//
//   • the sweep — a Caravan cron, so the tick is the queue's schedule and runs
//     once across replicas (`FJS-D36`). It asks `due()` of every declaring model
//     for rows due within the lookahead and dispatches a fire per row, with a
//     delay to its time, so the cadence is not the precision
//   • the fire — re-asks `due()` of that one row, then makes the transition as
//     system on the row `due()` names as its TARGET — the declaring row, or the
//     one a to-one relation reaches (`subscription.lapse` on an invoice,
//     `FJS-D362`). A row that moved, was held by `while:`, had its anchor
//     edited, or whose target already moved is no longer due, and the fire
//     does nothing
//
// The re-derivation is what lets a queue HOLD a time without OWNING it: a fire
// minted before its row moved finds nothing to do. Once-ness is the transition's
// own — the from-state is in the UPDATE's WHERE — so the queue key only stops
// two fires for one row being in flight at once. It is `unique` and not `id`
// for that reason: a stated id is idempotent for all time, and a row held by
// `while:` and later released comes due at the SAME time, so an id would have
// made its second fire a no-op forever.
//
// The fire always goes through `db.<model>.transition(id, name, { system: true })`
// on the app's own scoped client, and never through a service method of the
// same name. Measured on `example`:
// `subscriptions.cancel` is a service method that sets `cancelAtPeriodEnd`, and
// `cancel` is a transition that moves the row to `cancelled` — a match by name
// would have done the other thing. The move still announces, through the
// Litestone tap, under the transition's name.
//
// What a move OWES beyond itself — a closed period issues its invoice and opens
// the next one — is a hook the app names by commitment (`hooks:`). It runs in
// the move's own transaction, so the move and its effect commit together or
// neither does; an announcement is too late for it, being held until the
// commit. The plugin still makes the move, so an app cannot forget the
// from-state lock the fire's once-ness rests on.
//
// An effect outside the database — a reminder's email — is `enqueue`, an
// outbox row on the same transaction, and not `afterCommit`: a crash between
// the commit and the callback leaves the move saying the mail went when it
// never did, and a moved row is never due again.

import type { App, Plugin } from '../../core/app.ts'
import type { ServiceContext } from '../../core/context.ts'
import { forEachAppDatabase, enqueueOutbox } from '../../core/outbox.ts'
import type { EnqueueRef, EnqueueOptions, OutboxApi } from '../../core/outbox.ts'
import { startOfDay }         from '@frontierjs/toolbelt/datetime'

export interface CommitmentsPluginOptions {
  /**
   * When the sweep runs, as a five-field cron. Default every minute.
   *
   * Not the precision: a row due inside the lookahead is dispatched with a
   * delay to its own time, so a coarser sweep costs lateness only for a row
   * whose due time falls between a write and the next tick.
   */
  cron?:        string
  /**
   * How far ahead a sweep dispatches, in ms. Default 5 minutes.
   *
   * Must exceed the sweep's own interval or a row can fall due between two
   * ticks and wait for the next one. Longer holds more delayed jobs in the
   * queue, each of which re-derives when it runs, so it is never wrong — only
   * more rows in `jobs.db`.
   */
  lookaheadMs?: number
  /** The Caravan queue both jobs run on. Default Caravan's own default. */
  queue?:       string
  /**
   * Whose calendar a DAY-kind commitment (`on:` a `String @date`) is read in —
   * a zone, or a function of the tenant answering one. Default UTC, which is
   * `due()`'s own default stated rather than hidden.
   *
   * *Which day is it* is an instant read in a zone (`FJS-D143`), so an invoice
   * due on the 10th in Auckland is due thirteen hours before the 10th starts in
   * UTC. Read at the sweep and carried on the fire, so both answer the same day.
   * May answer a promise: a sweep reaches a tenant cold, where `configFor`
   * answers the app's floor rather than the tenant's own.
   */
  timeZone?:    string | ((tenant: string | null) => string | null | undefined | Promise<string | null | undefined>)
  /**
   * What a move owes beyond itself, keyed `<Model>.<commitment>` —
   * `'SubscriptionPeriod.close'`, `'Invoice.subscription.lapse'`.
   *
   * **Hook tier** (`FJS-D06`): it runs after the move inside the move's own
   * transaction, and a throw rolls both back and fails the fire, which
   * Caravan retries. Only the FIRE runs it — a `transition()` made anywhere
   * else is that caller's to follow up. A key naming no declared commitment is
   * refused at boot, because a renamed commitment would otherwise leave its
   * effect unrun with nothing saying so.
   */
  hooks?:       Record<string, CommitmentHook>
}

/** What a hook is handed. `db` is the fire's client inside the transaction. */
export interface CommitmentHookContext {
  db:          Record<string, any>
  /** The row the move was made on, as the transition answered it. */
  record:      Record<string, any>
  /** The declaring model and the commitment's name, as the key spells them. */
  model:       string
  commitment:  string
  /** When it fell due — an ISO instant, or a day for a `@date` anchor. */
  dueAt:       string
  /** The calendar the day was read in. */
  timeZone:    string
  /** The client's clock at the fire — what the hook stamps with. */
  now:         Date
  /**
   * Run `fn` once the transaction has committed — a dispatch to a queue in
   * another file, which a rollback could not take back. **Observer tier**: a
   * throw is logged, never reported as the fire failing, because the move is
   * already made.
   */
  afterCommit(fn: () => unknown): void
  /**
   * Write an outbox row on `db`, so the effect commits with the move or rolls
   * back with it — `ctx.enqueue`'s rule (`FJS-D35`), for the effect a crash
   * between the commit and an `afterCommit` would lose with the move already
   * saying it happened. The actor defaults to `null`: a fire is the app's own
   * work. Refuses by name with no `OutboxMessage` model or no relay installed.
   */
  enqueue(job: EnqueueRef, payload: unknown, opts?: EnqueueOptions): Promise<string>
}

export type CommitmentHook = (ctx: CommitmentHookContext) => unknown | Promise<unknown>

export interface CommitmentsApi {
  /**
   * One sweep, now. What the cron runs; exposed for a test that advances a
   * clock and for an operator who will not wait a minute.
   */
  sweep(): Promise<CommitmentSweepResult>
}

export interface CommitmentSweepResult {
  /**
   * Rows `due()` answered within the lookahead, across every declaration and
   * database — each one dispatched, which is a no-op for a fire already in flight.
   */
  due: number
}

/** The job names. Subject then verb, the caravan convention. */
export const COMMITMENT_SWEEP_JOB = 'commitment-sweep'
export const COMMITMENT_FIRE_JOB  = 'commitment-fire'

interface Declaration { model: string; accessor: string; transition: string }

interface CommitmentClient {
  $commitments: Declaration[]
  $now?:        () => Date
  asSystem():   Record<string, CommitmentTable> & { $primaryKey(accessor: string): string[] }
  $transaction<T>(fn: (tx: any) => Promise<T>): Promise<T>
}

interface DueRow {
  transition: string
  id:         unknown
  dueAt:      string
  target:     { accessor: string; transition: string; id: unknown }
}

interface CommitmentTable {
  due(args: { by?: Date | string; timeZone?: string; transition?: string; where?: Record<string, unknown> }): Promise<DueRow[]>
  transition(id: unknown, name: string, opts: { system: true }): Promise<Record<string, any>>
}

export interface FirePayload { accessor: string; transition: string; id: unknown; dueAt: string; timeZone?: string }

/** What one fire did: moved the row, found it no longer owed, or failed. */
export type FireOutcome = 'fired' | 'lapsed'

interface Jobs {
  handle(name: string, fn: (ctx: { data: FirePayload; tenantId?: string | null }) => Promise<void>, o?: Record<string, unknown>): void
  dispatch(name: string, data: unknown, o: Record<string, unknown>): Promise<string>
}

const DEFAULT_LOOKAHEAD_MS = 5 * 60 * 1_000

/** Does this client carry any declaration. `in` first: a Litestone client throws on an unknown property. */
function declares(db: unknown): boolean {
  return !!db && typeof db === 'object' && '$commitments' in db &&
    (db as CommitmentClient).$commitments.length > 0
}

export function commitments(opts: CommitmentsPluginOptions = {}): Plugin {
  const cron        = opts.cron        ?? '* * * * *'
  const lookaheadMs = opts.lookaheadMs ?? DEFAULT_LOOKAHEAD_MS
  const queue       = opts.queue
  const zoneFor     = async (tenant: string | null): Promise<string> =>
    (typeof opts.timeZone === 'function' ? await opts.timeZone(tenant) : opts.timeZone) ?? 'UTC'

  // What /metrics answers. `due` is the last sweep's count; the other three are
  // cumulative since boot. `lapsed` counts fires that found their row no longer
  // due, which is how much of the queue the re-derivation is absorbing.
  let due        = 0
  let fired      = 0
  let lapsed     = 0
  let failed     = 0
  let lastSweepAt: string | null = null

  let api: CommitmentsApi | null = null

  return {
    name:     'commitments',
    requires: ['caravan'],

    register(app: App): void {
      api = { sweep: () => sweep(app) }
      if (typeof app.claim === 'function') app.claim('commitments', api)
      else (app as { commitments?: CommitmentsApi }).commitments = api

      // A source must be SYNCHRONOUS — `/metrics` assigns `fn()` straight into
      // the body, so a promise would serialize as `{}`.
      if (typeof app.registerMetricsSource === 'function')
        app.registerMetricsSource('commitments', () => ({ due, fired, lapsed, failed, lastSweepAt }))
    },

    async boot(app: App): Promise<void> {
      const jobs = app.jobs as unknown as Jobs | undefined
      if (!jobs?.handle) throw new Error(
        `[Junction] commitments(): app.jobs has no handle() — configure caravan before commitments().`)

      const keys = Object.keys(opts.hooks ?? {})
      if (keys.length) {
        const declared = declaredKeys(app)
        const unknown  = keys.filter(k => !declared.has(k))
        if (unknown.length) throw new Error(
          `[Junction] commitments(): hooks name ${unknown.map(k => `'${k}'`).join(', ')}, which no ` +
          `@@commitment declares — declared: ${[...declared].join(', ') || 'none'}.`)
      }

      jobs.handle(COMMITMENT_FIRE_JOB, ctx => fire(app, ctx.data, ctx.tenantId ?? null), { queue })

      // Registered through handle() with a cron rather than schedule(): the
      // sweep is the same in every database this build runs against, so it
      // belongs in jobs.snapshot.md, and schedule() is the door a ROW binds a
      // clock through, which registrations() leaves out.
      jobs.handle(COMMITMENT_SWEEP_JOB, async () => { await sweep(app) }, { queue, cron })
    },
  }

  /**
   * Ask every declaring model in every database for rows due within the
   * lookahead, and dispatch one fire per row. The clock is the CLIENT's, so a
   * test's `env.clock.advance()` moves what a sweep sees, and the delay is
   * measured on the same clock.
   */
  async function sweep(app: App): Promise<CommitmentSweepResult> {
    const jobs = app.jobs as unknown as Jobs
    let count = 0

    await forEachAppDatabase(app, declares, async (raw, tenant) => {
      const db  = raw as CommitmentClient
      const sys = db.asSystem()
      const now = (db.$now?.() ?? new Date()).getTime()
      const by  = new Date(now + lookaheadMs)
      const timeZone = await zoneFor(tenant ?? null)

      for (const accessor of new Set(db.$commitments.map(d => d.accessor))) {
        for (const row of await sys[accessor].due({ by, timeZone })) {
          count++
          // A day kind answers `YYYY-MM-DD`, which Date.parse reads as UTC
          // midnight — the fire would run hours early or late anywhere else.
          const at = row.dueAt.length === 10 ? startOfDay(row.dueAt, timeZone) : Date.parse(row.dueAt)
          await jobs.dispatch(COMMITMENT_FIRE_JOB,
            { accessor, transition: row.transition, id: row.id, dueAt: row.dueAt, timeZone } satisfies FirePayload, {
              queue,
              delay:  Math.max(0, at - now),
              unique: `commitment:${tenant ?? ''}:${accessor}:${row.transition}:${String(row.id)}:${row.dueAt}`,
              actor:  null,
              tenant,
            })
        }
      }
    })

    due         = count
    lastSweepAt = new Date().toISOString()
    return { due: count }
  }

  /**
   * Re-derive, then move. The tenant is the one the fire was dispatched for,
   * re-bound by Caravan, so `withDb` answers that tenant's client, scoped to
   * the app's own principal (`createApp({ system })`) — a fire is work nobody
   * asked for. `fireCommitment` below is the rest.
   */
  async function fire(app: App, job: FirePayload, tenant: string | null): Promise<void> {
    await app.withDb(async (raw) => {
      try {
        if (await fireCommitment(raw, job, { hooks: opts.hooks, outbox: app.outbox, tenant }) === 'fired') fired++
        else lapsed++
      } catch (err) { failed++; throw err }
    })
  }
}

/**
 * Every `<Model>.<commitment>` the app declares — off `app.db`, or off the
 * tenant registry's parsed schema where there is no `app.db`, for the reason
 * `check-authoring` gives: opening a tenant to ask would create its file.
 */
function declaredKeys(app: App): Set<string> {
  const db = app.db as unknown
  if (declares(db)) return new Set((db as CommitmentClient).$commitments.map(d => `${d.model}.${d.transition}`))
  const models = (app as { tenants?: { schema?: { models?: Array<{ name: string; attributes: Array<{ kind: string; name?: string }> }> } } })
    .tenants?.schema?.models ?? []
  return new Set(models.flatMap(m => m.attributes.filter(a => a.kind === 'commitment').map(a => `${m.name}.${a.name}`)))
}

/**
 * One fire against one client: re-derive, then move, then the hook — the
 * plugin's own path, exported so a drive with no app can run it rather than a
 * copy of it.
 *
 * The READ is as system and the MOVE is not. `asSystem()` bypasses
 * `@@transitions` whole — no from-state in the WHERE — so a move made
 * through it would take a row that was paid a moment ago straight to
 * cancelled, and the lock that makes a fire happen once would be gone.
 * `{ system: true }` on the caller's client unlocks the `@system` move and
 * nothing else: the graph, the gate and the row policy all still grade it,
 * and a refusal is a failed job rather than a lapse nobody sees. The plugin
 * hands it the tenant's client scoped to `createApp({ system })`.
 */
export async function fireCommitment(
  raw: unknown,
  job: FirePayload,
  { hooks, outbox, tenant = null }: {
    hooks?:  Record<string, CommitmentHook>
    /** The relay `enqueue` writes for and kicks after the commit — `app.outbox`. */
    outbox?: OutboxApi
    /** The tenant `raw` belongs to, which the kicked delivery dispatches under. */
    tenant?: string | null
  } = {},
): Promise<FireOutcome> {
  const db    = raw as CommitmentClient & Record<string, CommitmentTable>
  const sys   = db.asSystem()
  const key   = sys.$primaryKey(job.accessor)[0] ?? 'id'
  const owed  = async () =>
    (await sys[job.accessor].due({ transition: job.transition, timeZone: job.timeZone, where: { [key]: job.id } }))[0]

  // The target is read here and not carried in the payload: a relation
  // re-pointed since the sweep moves the one it points at NOW, and a target
  // that already moved — the later of two unpaid invoices — is answered as
  // nothing due by the same read, not as a refused move.
  const row = await owed()
  if (!row) return 'lapsed'

  const model = db.$commitments.find(d => d.accessor === job.accessor)?.model ?? job.accessor
  const hook  = hooks?.[`${model}.${job.transition}`]
  const later: Array<() => unknown> = []
  const rows:  string[] = []

  try {
    if (!hook) await db[row.target.accessor].transition(row.target.id, row.target.transition, { system: true })
    else await db.$transaction(async (tx) => {
      const record = await tx[row.target.accessor].transition(row.target.id, row.target.transition, { system: true })
      await hook({
        db: tx, record, model, commitment: job.transition, dueAt: row.dueAt,
        timeZone: job.timeZone ?? 'UTC', now: db.$now?.() ?? new Date(),
        afterCommit: (fn) => { later.push(fn) },
        // enqueueOutbox reads four things off a call context; a fire is not a
        // call, so it is handed exactly those, and its refusals name the key.
        enqueue: (name, payload, o) => enqueueOutbox({
          locals: { db: tx }, service: 'commitments', method: `${model}.${job.transition}`,
          app: { outbox }, auth: undefined, _outbox: rows,
        } as unknown as ServiceContext, name, payload, { actor: null, ...o }),
      })
    })
  } catch (err) {
    // A concurrent write moved the row between the re-derivation and the
    // UPDATE — the transition's own lock refused it. Asked again rather than
    // read off the error's class, because the question is whether the row is
    // still owed the move, and only due() answers that.
    if (!(await owed())) return 'lapsed'
    throw err
  }

  for (const fn of later) {
    try { await fn() }
    catch (err) { console.warn(`[Junction] commitments(): an afterCommit of ${model}.${job.transition} threw:`, err) }
  }
  // Latency only, as after a service call: the rows are committed and the
  // relay's own timer finds them regardless.
  if (rows.length && outbox) void outbox.deliver({ db: raw, tenant }).catch((err: unknown) =>
    console.warn(`[Junction] commitments(): the outbox kick after ${model}.${job.transition} failed:`, err))
  return 'fired'
}
