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
//   • the kick — a committed write to a declaring model asks `due()` of that
//     row and dispatches its fire at once, so a row due at its own write waits
//     for no tick. The sweep is the backstop for a write this process never
//     saw, and a sweep after a kick may find the row already moved
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
// the next one — is a `defineCommitment({ before, after, around })` the app
// names by commitment (`hooks:`), the service pipeline's tiers in its order
// (`FJS-D1022`). All three run in the move's own transaction, so the move and
// its effect commit together or neither does; an announcement is too late for
// it, being held until the commit. `before` is where a SEALING move's owed
// writes go — after the seal the row refuses them, and a look-up of the draft
// finds none and writes a second one (`FJS-2163`). `after` is where a write
// the move's own from-state contends with goes: a renewal opening the next
// period while the closing one still holds an open-period guard. The plugin
// still makes the move, so an app cannot forget the from-state lock the fire's
// once-ness rests on.
//
// An effect outside the database — a reminder's email — is `enqueue`, an
// outbox row on the same transaction, and not `afterCommit`: a crash between
// the commit and the callback leaves the move saying the mail went when it
// never did, and a moved row is never due again.

import type { App, Plugin } from '../../core/app.ts'
import type { ServiceContext } from '../../core/context.ts'
import type { LitestoneWriteEvent } from '../../core/litestone.ts'
import { forEachAppDatabase, enqueueOutbox } from '../outbox/engine.ts'
import type { EnqueueRef, EnqueueOptions, OutboxApi } from '../outbox/engine.ts'
import { startOfDay }         from '@frontierjs/toolbelt/datetime'

export interface CommitmentsPluginOptions {
  /**
   * When the sweep runs, as a five-field cron. Default every minute.
   *
   * Not the precision: a row due inside the lookahead is dispatched with a
   * delay to its own time, and a write that makes a row due kicks its fire at
   * once. A coarser sweep costs lateness only for a write another process made.
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
   * `'SubscriptionPeriod.close'`, `'Invoice.subscription.lapse'` — each a
   * `defineCommitment({ before, after, around })`.
   *
   * **Hook tier** (`FJS-D06`): every tier runs inside the move's own
   * transaction, and a throw rolls the move back and fails the fire, which
   * Caravan retries. Only the FIRE runs them — a `transition()` made anywhere
   * else is that caller's to follow up. A key naming no declared commitment, or
   * a value that is not a spec, is refused at boot: a renamed commitment or a
   * bare function would otherwise leave its effect unrun with nothing saying so.
   */
  hooks?:       Record<string, CommitmentSpec>
}

/** What a hook is handed. `db` is the fire's client inside the transaction. */
export interface CommitmentHookContext {
  db:          Record<string, any>
  /**
   * The row the move is made on — at its from-state in `before` and in
   * `around` before `next()`, as the transition answered it in `after` and
   * in `around` after `next()`.
   */
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

export type CommitmentHook   = (ctx: CommitmentHookContext) => unknown | Promise<unknown>
/** `next()` runs `before`, the move and `after`; an `around` that never calls it fails the fire. */
export type CommitmentAround = (ctx: CommitmentHookContext, next: () => Promise<void>) => unknown | Promise<unknown>

/**
 * What one commitment's move owes, in the service pipeline's order:
 * `around` enter → `before` → the move → `after` → `around` exit.
 */
export interface CommitmentSpec {
  /** Before the move, on the row at its from-state — what a `@seals` move owes. */
  before?: CommitmentHook
  /** After the move, on the moved row — a write the from-state would contend with. */
  after?:  CommitmentHook
  around?: CommitmentAround
}

const SPEC_TIERS = ['before', 'after', 'around'] as const

/** One commitment's hooks, typed. The spec is returned as given. */
export function defineCommitment(spec: CommitmentSpec): CommitmentSpec {
  return spec
}

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
  /** The row's tenancy column, answered under `strategy row` only. */
  tenant?:    string | null
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
  const zoneFor     = (tenant: string | null): Promise<string> => zoneIn(opts.timeZone, tenant)

  // What /metrics answers. `due` is the last sweep's count; the other three are
  // cumulative since boot. `lapsed` counts fires that found their row no longer
  // due, which is how much of the queue the re-derivation is absorbing.
  let due        = 0
  let fired      = 0
  let lapsed     = 0
  let failed     = 0
  let lastSweepAt: string | null = null

  let api: CommitmentsApi | null = null
  const untap: Array<() => void> = []

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

      refuseUnknownHooks(app, opts.hooks, 'commitments()')

      await refuseUnprincipled(app)

      jobs.handle(COMMITMENT_FIRE_JOB, ctx => fire(app, ctx.data, ctx.tenantId ?? null), { queue })

      // Registered through handle() with a cron rather than schedule(): the
      // sweep is the same in every database this build runs against, so it
      // belongs in jobs.snapshot.md, and schedule() is the door a ROW binds a
      // clock through, which registrations() leaves out.
      jobs.handle(COMMITMENT_SWEEP_JOB, async () => { await sweep(app) }, { queue, cron })

      // Under `tenants` there is no one client to tap: each is tapped as it opens.
      kickOnWrites(app, app.db, null)
      if (typeof app.onTenantClient === 'function')
        untap.push(app.onTenantClient((client, id) => kickOnWrites(app, client, id)))
    },

    async shutdown(): Promise<void> {
      for (const off of untap.splice(0)) off()
    },
  }

  /**
   * Ask every declaring model in every database for rows due within the
   * lookahead, and dispatch one fire per row. The clock is the CLIENT's, so a
   * test's `env.clock.advance()` moves what a sweep sees, and the delay is
   * measured on the same clock.
   */
  async function sweep(app: App): Promise<CommitmentSweepResult> {
    let count = 0

    await forEachAppDatabase(app, declares, async (raw, tenant) => {
      const db = raw as CommitmentClient
      for (const accessor of new Set(db.$commitments.map(d => d.accessor)))
        count += await dispatchDue(app, db, tenant, accessor)
    })

    due         = count
    lastSweepAt = new Date().toISOString()
    return { due: count }
  }

  /**
   * Dispatch a fire for each row of one accessor due within the lookahead —
   * all of them, or the one `where` names. The sweep walks every accessor; a
   * write that may have made a row due asks for that row alone.
   */
  async function dispatchDue(
    app: App, db: CommitmentClient, tenant: string | null, accessor: string, where?: Record<string, unknown>,
  ): Promise<number> {
    const jobs = app.jobs as unknown as Jobs
    const now  = (db.$now?.() ?? new Date()).getTime()
    const by   = new Date(now + lookaheadMs)
    const timeZone = await zoneFor(tenant ?? null)
    let count = 0

    for (const row of await db.asSystem()[accessor].due({ by, timeZone, where })) {
      count++
      // Under row tenancy the database is every tenant's and names none;
      // the row's own tenant is what the fire's principal holds as its claim.
      const rowTenant = row.tenant !== undefined ? row.tenant : tenant
      // A day kind answers `YYYY-MM-DD`, which Date.parse reads as UTC
      // midnight — the fire would run hours early or late anywhere else.
      const at = row.dueAt.length === 10 ? startOfDay(row.dueAt, timeZone) : Date.parse(row.dueAt)
      await jobs.dispatch(COMMITMENT_FIRE_JOB,
        { accessor, transition: row.transition, id: row.id, dueAt: row.dueAt, timeZone } satisfies FirePayload, {
          queue,
          delay:  Math.max(0, at - now),
          unique: `commitment:${rowTenant ?? ''}:${accessor}:${row.transition}:${String(row.id)}:${row.dueAt}`,
          actor:  null,
          tenant: rowTenant,
        })
    }
    return count
  }

  /**
   * Kick a fire for a row the moment a committed write may have made it due,
   * where the sweep alone would leave it to the next tick — the outbox's
   * post-commit kick, for the commonest commitment: one due at its own write.
   * A tap's callback runs after the commit, so the row it reads is there. The
   * sweep stays the backstop for a write this process did not see.
   */
  function kickOnWrites(app: App, raw: unknown, tenant: string | null): void {
    if (!declares(raw)) return
    const db = raw as CommitmentClient
    const tap = (db as { $tapEvents?: (fn: (e: LitestoneWriteEvent) => void) => () => void }).$tapEvents
    if (typeof tap !== 'function') return
    const accessors = new Map(db.$commitments.map(d => [d.model, d.accessor]))
    untap.push(tap.call(db, (e) => {
      const accessor = accessors.get(e.model)
      if (!accessor || e.event === 'remove') return
      const row = (e.event === 'transition' ? e.record : e.result) as Record<string, unknown> | null | undefined
      const keys = db.asSystem().$primaryKey(accessor)
      const where = e.scope !== 'collection' && row && keys.every(k => k in row)
        ? Object.fromEntries(keys.map(k => [k, row[k]]))
        : undefined
      void dispatchDue(app, db, tenant, accessor, where).catch((err: unknown) =>
        (err as { name?: string })?.name === 'ClientClosedError' ||
        console.warn(`[Junction] commitments(): the kick after a ${e.model} write failed:`, err))
    }))
  }

  /** One fire as Caravan runs it — the tenant and principal re-bound by the queue. */
  async function fire(app: App, job: FirePayload, tenant: string | null): Promise<void> {
    try {
      if (await fireAsApp(app, job, tenant, opts.hooks) === 'fired') fired++
      else lapsed++
    } catch (err) {
      failed++
      throw err
    }
  }
}

/** A day kind's calendar — the option's zone, or its answer for this tenant; UTC unstated. */
async function zoneIn(opt: CommitmentsPluginOptions['timeZone'], tenant: string | null): Promise<string> {
  return (typeof opt === 'function' ? await opt(tenant) : opt) ?? 'UTC'
}

/**
 * Re-derive, then move, inside the principal and tenant the caller bound — a
 * Caravan job's `runAs(null, { tenant })`, or `fireDue`'s own — so `withDb`
 * answers that tenant's client, scoped to the app's own principal
 * (`createApp({ system })`): a fire is work nobody asked for. `fireCommitment`
 * below is the rest.
 */
async function fireAsApp(
  app: App, job: FirePayload, tenant: string | null, hooks: Record<string, CommitmentSpec> | undefined,
): Promise<FireOutcome> {
  return app.withDb(async (raw) => {
    try {
      return await fireCommitment(raw, job, { hooks, outbox: app.outbox, tenant })
    } catch (err) {
      // With no system principal the fire is STRANGER(0), and the gate's
      // refusal names the level it wanted, not the principal nobody declared.
      if (app.principal?.() || !(err instanceof Error)) throw err
      throw new Error(`${err.message} — the fire ran as nobody: this app declares no createApp({ system }).`, { cause: err })
    }
  })
}

export interface FireDueOptions {
  /** What a move owes beyond itself — the `hooks` the app hands `commitments()`, run by each fire. */
  hooks?:    Record<string, CommitmentSpec>
  /** Whose calendar a day-kind `on:` is read in — `commitments({ timeZone })`'s option. */
  timeZone?: CommitmentsPluginOptions['timeZone']
}

export interface FireDueResult {
  /** Rows `due()` answered by the client's clock, across every declaration and database. */
  due:    number
  /** Of those, how many moved, and how many were no longer owed when their fire asked again. */
  fired:  number
  lapsed: number
}

/**
 * Every row owed a move by the client's clock NOW, fired now in this process —
 * the sweep and the fire with no queue between them (`FJS-D938`).
 *
 * For an app built in-process with no queue, which keeps no time of its own and
 * so is not refused for configuring no `commitments()`: its test is the clock.
 * Set the client's (`env.clock.set()`), then `await fireDue(app)`. Each fire is
 * the plugin's own — as `createApp({ system })` in the row's tenant, re-derived
 * before it moves, `hooks` in the move's transaction — and one that fails
 * throws, where the queue would have retried it. Nothing fires early: no
 * lookahead, only what is due by now.
 */
export async function fireDue(app: App, opts: FireDueOptions = {}): Promise<FireDueResult> {
  refuseUnknownHooks(app, opts.hooks, 'fireDue()')

  // Collected first and fired after the walk: under a tenant registry the walk
  // holds each tenant's client, and a fire leases that tenant's client again.
  const owed: Array<{ job: FirePayload; tenant: string | null }> = []
  await forEachAppDatabase(app, declares, async (raw, tenant) => {
    const db       = raw as CommitmentClient
    const timeZone = await zoneIn(opts.timeZone, tenant)
    for (const accessor of new Set(db.$commitments.map(d => d.accessor)))
      for (const row of await db.asSystem()[accessor].due({ timeZone }))
        owed.push({
          job:    { accessor, transition: row.transition, id: row.id, dueAt: row.dueAt, timeZone },
          // Under row tenancy the database names no tenant; the row's own is the fire's.
          tenant: row.tenant !== undefined ? row.tenant : tenant,
        })
  })

  const out: FireDueResult = { due: owed.length, fired: 0, lapsed: 0 }
  for (const { job, tenant } of owed)
    out[await app.runAs(null, { tenant }, () => fireAsApp(app, job, tenant, opts.hooks))]++
  return out
}

/**
 * A hook keyed by a commitment nothing declares is refused, because a renamed
 * commitment would otherwise leave its effect unrun with nothing saying so. A
 * value that is not a spec is refused for the same reason: a bare function, or
 * a tier spelled `afer`, would be read as no tier at all.
 */
function refuseUnknownHooks(app: App, hooks: Record<string, CommitmentSpec> | undefined, who: string): void {
  const keys = Object.keys(hooks ?? {})
  if (!keys.length) return
  for (const k of keys) {
    const spec = hooks![k] as unknown
    const ok = !!spec && typeof spec === 'object' && !Array.isArray(spec) &&
      Object.entries(spec).every(([tier, fn]) => (SPEC_TIERS as readonly string[]).includes(tier) && (fn === undefined || typeof fn === 'function'))
    if (!ok) throw new Error(
      `[Junction] ${who}: hooks '${k}' is not a defineCommitment({ before, after, around }) — ` +
      `each tier a function, and no other key.`)
  }
  const declared = declaredKeys(app)
  const unknown  = keys.filter(k => !declared.has(k))
  if (unknown.length) throw new Error(
    `[Junction] ${who}: hooks name ${unknown.map(k => `'${k}'`).join(', ')}, which no ` +
    `@@commitment declares — declared: ${[...declared].join(', ') || 'none'}.`)
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
 * A fire runs as `createApp({ system })`, and with none it is STRANGER(0): every
 * `@system` move on a graded model is refused, retried, and named only in the
 * job's error. A model declaring no `@@gate` has nothing to refuse it, so it
 * needs no principal. Not asked under `tenants`, where no client opens without
 * a tenant.
 */
async function refuseUnprincipled(app: App): Promise<void> {
  const db = app.db as (CommitmentClient & { $schema?: { models: Array<{ name: string; attributes: Array<{ kind: string }> }> } }) | undefined
  if (!declares(db) || await app.runAs(null, user => user)) return
  const gated = new Set((db!.$schema?.models ?? []).filter(m => m.attributes.some(a => a.kind === 'gate')).map(m => m.name))
  const graded = db!.$commitments.filter(d => gated.has(d.model))
  if (!graded.length) return
  throw new Error(
    `[Junction] commitments(): ${graded.map(d => `${d.model}.${d.transition}`).join(', ')} ` +
    `${graded.length > 1 ? 'are' : 'is'} declared on a gated model, and a fire runs as ` +
    `createApp({ system }) — this app declares none, so every move would be refused as STRANGER(0).`)
}

/**
 * One fire against one client: re-derive, then the spec's tiers around the move
 * — the plugin's own path, exported so a drive with no app can run it rather than a
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
    hooks?:  Record<string, CommitmentSpec>
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
  const spec  = hooks?.[`${model}.${job.transition}`]
  const later: Array<() => unknown> = []
  const rows:  string[] = []

  // A move on a row this client cannot see answers null, as on a row that does
  // not exist (`FJS-1093`), so a null is the row policy hiding an owed row from
  // the fire's principal — counted as fired, the job went done and the row
  // never moved.
  const unseen = () => new Error(
    `[Junction] commitments(): ${model}.${job.transition} is owed on ${row.target.accessor} ` +
    `${String(row.target.id)} and the move found no row — the fire's principal cannot see it. ` +
    `A fire runs as createApp({ system }); declare one, and a row policy on ${row.target.accessor} ` +
    `that admits it.`)

  try {
    if (!spec || !(spec.before || spec.after || spec.around)) {
      if (!await db[row.target.accessor].transition(row.target.id, row.target.transition, { system: true })) throw unseen()
    }
    else await db.$transaction(async (tx) => {
      // The from-state row is read through the fire's own client, so `before`
      // sees what the move will be graded on; the move's WHERE is still the lock.
      const pk   = sys.$primaryKey(row.target.accessor)[0] ?? 'id'
      const from = await tx[row.target.accessor].findUnique({ where: { [pk]: row.target.id } })
      // A row policy hides the row from the read as quietly as from the move, but
      // the gate refuses only the move, and its refusal names the level it wanted.
      if (!from) {
        await tx[row.target.accessor].transition(row.target.id, row.target.transition, { system: true })
        throw unseen()
      }
      const ctx: CommitmentHookContext = {
        db: tx, record: from, model, commitment: job.transition, dueAt: row.dueAt,
        timeZone: job.timeZone ?? 'UTC', now: db.$now?.() ?? new Date(),
        afterCommit: (fn) => { later.push(fn) },
        // enqueueOutbox reads four things off a call context; a fire is not a
        // call, so it is handed exactly those, and its refusals name the key.
        // The fire's tenant rides on `locals` as a call's does, so the row
        // records it (`FJS-2508`): under `strategy row` the relay's sweep has
        // nothing else to dispatch a missed kick into.
        enqueue: (name, payload, o) => enqueueOutbox({
          locals: { db: tx, tenantId: tenant }, service: 'commitments', method: `${model}.${job.transition}`,
          app: { outbox }, auth: undefined, _outbox: rows,
        } as unknown as ServiceContext, name, payload, { actor: null, ...o }),
      }
      let moved = false
      const next = async (): Promise<void> => {
        if (moved) throw new Error(`[Junction] commitments(): ${model}.${job.transition}'s around called next() twice.`)
        moved = true
        await spec.before?.(ctx)
        const record = await tx[row.target.accessor].transition(row.target.id, row.target.transition, { system: true })
        if (!record) throw unseen()
        ctx.record = record
        await spec.after?.(ctx)
      }
      if (!spec.around) return next()
      await spec.around(ctx, next)
      // A fire that answered without the move would count as made with the row
      // still owed, and the next sweep would run every tier again.
      if (!moved) throw new Error(
        `[Junction] commitments(): ${model}.${job.transition}'s around returned without calling next() — the move was not made.`)
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

// The battery fills its own slot (`FJS-D640`); augment, never redeclare `App.commitments`.
declare module '../../core/app.ts' {
  interface AppCommitments extends CommitmentsApi {}
}
