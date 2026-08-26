// core/outbox.ts
// The transactional outbox — an effect that survives a crash.
//
// `ctx.afterCommit(fn)` runs an effect only if the call succeeded and the
// transaction committed, which is the ORDERING half. It buys nothing against a
// crash: the process dies between the commit and the callback and the effect is
// simply never done, with nothing recorded anywhere that it was owed.
//
// `ctx.enqueue(job, payload)` is the durable half. It writes a row INSIDE the
// call's own transaction, so the intent is recorded if and only if the write it
// belongs to committed; a relay then hands the row to `app.jobs` and marks it
// delivered. The two are separate verbs and not one verb with a flag, because a
// closure cannot be persisted — everything durable is a NAME and a PAYLOAD, and
// the API says so rather than discovering it at the first crash.
//
// The row is in the app's OWN database and can be nowhere else (`FJS-D35`):
// litestone opens one connection per declared `database` block and the
// transaction manager holds main's alone, so a row in a second database
// survives the rollback that was supposed to take it. Caravan's queue is a
// separate file for the same reason, which is what makes the handoff between
// them at-least-once — see `deliverOutbox`.

import { occurrenceKey } from '@frontierjs/toolbelt/history'
import { readFileSync } from 'node:fs'

import type { ServiceContext } from './context.ts'
import type { App } from './app.ts'

/** The model `packages/junction/db/outbox.lite` declares, and its accessor. */
export const OUTBOX_MODEL    = 'OutboxMessage'
export const OUTBOX_ACCESSOR = 'outboxMessage'

// ─── The client ───────────────────────────────────────────────────────────────

/**
 * A Litestone client, minus every model — this module names exactly one and
 * cannot be typed against a generated client that has never heard of it.
 */
interface OutboxClient {
  $schema?:        { models?: Array<{ name: string }> }
  $inTransaction?: boolean
  asSystem():      OutboxClient
  [accessor: string]: unknown
}

export interface OutboxRow {
  id:          string
  job:         string
  payload:     unknown
  actorId:     string | null
  claimedAt:   string | null
  deliveredAt: string | null
  attempts:    number
  lastError:   string | null
  createdAt:   string
}

interface OutboxTable {
  create(args:     { data: Record<string, unknown> }): Promise<OutboxRow>
  update(args:     { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<OutboxRow>
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>
  removeMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>
  findMany(args:   Record<string, unknown>): Promise<OutboxRow[]>
  count(args?:     Record<string, unknown>): Promise<number>
}

/** Reading an unknown property off a Litestone client throws by design. */
export function hasOutboxModel(client: unknown): boolean {
  let models: Array<{ name: string }> | undefined
  try {
    models = (client as OutboxClient)?.$schema?.models
  } catch { return false }
  return Array.isArray(models) && models.some(m => m.name === OUTBOX_MODEL)
}

/**
 * The outbox table, through the system bypass.
 *
 * `@@gate("8")` says nothing below `asSystem()` has anything to say to this
 * model, and that includes the request whose effect this is: an outbox row is
 * the framework's bookkeeping, not the caller's data.
 */
function outboxTable(client: OutboxClient): OutboxTable {
  return client.asSystem()[OUTBOX_ACCESSOR] as OutboxTable
}

// ─── enqueue ──────────────────────────────────────────────────────────────────

/** What a caller may state at enqueue. */
export interface EnqueueOptions {
  /**
   * Whose behalf the effect is on. Default: the principal on the call, so a
   * durable effect names the same actor an immediate dispatch would.
   * State `null` for work that is the app's own.
   */
  actor?: string | null
}

/** A definition carries its own name; a string is the caller restating it. */
export type EnqueueRef = string | { name: string }

export async function enqueueOutbox(
  ctx:  ServiceContext,
  job:  EnqueueRef,
  data: unknown,
  opts: EnqueueOptions = {}
): Promise<string> {
  const name = typeof job === 'string' ? job : job.name
  const db   = ctx.locals.db as OutboxClient | undefined
  const at   = `${ctx.service}.${String(ctx.method)}`

  if (!db || typeof db.asSystem !== 'function')
    throw new Error(
      `ctx.enqueue('${name}') in '${at}': ctx.locals.db is not a Litestone client. ` +
      `The outbox row has to be written on the connection the call is already writing through — ` +
      `build the app with createApp({ db }).`
    )

  if (!hasOutboxModel(db))
    throw new Error(
      `ctx.enqueue('${name}') in '${at}': this schema declares no ${OUTBOX_MODEL}. ` +
      `Run 'fli outbox:install' to import it, or use ctx.afterCommit(fn) for an effect that may be lost in a crash.`
    )

  // The whole guarantee. Outside a transaction the row and the write it belongs
  // to are two independent statements, so the intent can be recorded for a call
  // that then fails — which is the failure this exists to remove, wearing the
  // other face. Asked of the CONNECTION rather than of `transactional:`,
  // because a hook can run against a method the declaration does not name.
  if (db.$inTransaction !== true)
    throw new Error(
      `ctx.enqueue('${name}') in '${at}': no transaction is open. ` +
      `An outbox row is only worth writing if it rolls back with the write it belongs to — ` +
      `declare transactional: ['${String(ctx.method)}'] on the '${ctx.service}' service.`
    )

  if (!ctx.app?.outbox)
    throw new Error(
      `ctx.enqueue('${name}') in '${at}': no outbox relay is installed, so this row would never be delivered. ` +
      `app.configure(outbox()) — it needs app.jobs, so configure caravan too.`
    )

  const actorId = 'actor' in opts
    ? opts.actor ?? null
    : ctx.auth?.user?.userId ?? null

  const row = await outboxTable(db).create({
    data: { job: name, payload: data ?? {}, actorId },
  })

  // What callService kicks the relay for. A row already committed is the
  // relay's to find on its next sweep regardless; this only buys the latency.
  ;(ctx._outbox ??= []).push(row.id)
  return row.id
}

// ─── The relay ────────────────────────────────────────────────────────────────

// ─── Which databases hold rows ────────────────────────────────────────────────
//
// `ctx.enqueue` writes through `ctx.locals.db`, which under
// `tenancy { strategy database }` is THIS TENANT's client. The relay used to
// read `app.db` and nothing else, so the row was written to one file and looked
// for in another — and every guard on the path passed: the tenant file carries
// the same schema so the enqueue was accepted, and `createApp({ tenants })`
// sets no `db`, so the relay's own empty-check reported a clean pass over an
// empty queue forever (`FJS-365`).
//
// So the relay resolves the same set of databases the request path can write
// to. Two shapes are legal — the outbox is per tenant, or it is schema-global
// in a `database` block that is not — and the AMBIGUOUS one refuses, on
// `ctx.enqueue`'s own stated ground that a row nothing delivers is worse than
// a refusal.

interface TenantRegistryLike {
  list(): string[]
  get(id: string): Promise<unknown>
}

interface OutboxSource { db: OutboxClient; tenant: string | null }

/**
 * Every database this app's outbox rows can be in, with the tenant each one is.
 *
 * An app with no tenancy is one entry and `null`. An app with a tenant registry
 * is one entry per tenant, and the sweep cost is one query per tenant per pass
 * — which is the honest cost of having put the rows there.
 */
async function outboxDatabases(app: App): Promise<OutboxSource[]> {
  const db       = app.db as OutboxClient | undefined
  const registry = (app as { tenants?: TenantRegistryLike }).tenants

  if (!registry) return db && hasOutboxModel(db) ? [{ db, tenant: null }] : []

  // Both, which is the shape that cannot be resolved: rows are written to the
  // tenant's file by every request, and `app.db` is a real database that is
  // nobody's. Refused rather than half-swept.
  if (db && hasOutboxModel(db)) throw new Error(
    `[Junction] outbox: this app was built with BOTH createApp({ db }) and ` +
    `createApp({ tenants }), and ${OUTBOX_MODEL} is declared in the app-level ` +
    `database as well as in the tenants'. A row is written to whichever client ` +
    `the call ran through, so half of them would never be delivered. Declare ` +
    `the outbox in one place: drop the app-level db, or move ${OUTBOX_MODEL} ` +
    `into a database block that is not per-tenant.`
  )

  const out: OutboxSource[] = []
  for (const id of registry.list()) {
    const client = await registry.get(id) as OutboxClient
    if (hasOutboxModel(client)) out.push({ db: client, tenant: id })
  }
  return out
}

export interface DeliverOptions {
  /** How many rows one pass may take. */
  batch?:          number
  /** A claim older than this is retaken — a relay died mid-handoff. */
  claimTimeoutMs?: number
}

export interface DeliverResult {
  delivered: number
  failed:    number
}

interface JobDispatcher {
  dispatch(name: string, data: unknown, opts: Record<string, unknown>): Promise<string>
}

/**
 * One pass: claim what is owed, hand it to the queue, mark it delivered.
 *
 * **At-least-once, and no version of this is not.** The queue is a different
 * SQLite file, so the insert there and the delivery mark here cannot be one
 * transaction; a crash between them replays. The replay is a no-op rather than
 * duplicate work because the dispatch states the outbox row's id and caravan
 * treats a taken primary key as work already queued. The id is NAMESPACED
 * (`occurrenceKey('outbox', id)`): the jobs table is shared with every id a
 * caller states on a dispatch of their own, and a bare row id meant outbox row
 * 7 and a caller's `7` were one primary key, so whichever arrived second was
 * silently treated as already done. That leaves exactly one
 * hole, a handler that runs, crashes the process before caravan marks the job
 * done, and is retried by the queue. That is the queue's own retry contract,
 * so a handler must be idempotent either way.
 */
export async function deliverOutbox(
  app:  App,
  opts: DeliverOptions = {}
): Promise<DeliverResult> {
  const jobs = app.jobs as unknown as JobDispatcher | undefined
  if (typeof jobs?.dispatch !== 'function') return { delivered: 0, failed: 0 }

  const total: DeliverResult = { delivered: 0, failed: 0 }
  for (const { db, tenant } of await outboxDatabases(app)) {
    const one = await deliverFrom(db, jobs, tenant, opts)
    total.delivered += one.delivered
    total.failed    += one.failed
  }
  return total
}

/** One pass over one database. */
async function deliverFrom(
  db:     OutboxClient,
  jobs:   JobDispatcher,
  tenant: string | null,
  opts:   DeliverOptions,
): Promise<DeliverResult> {
  const batch   = opts.batch          ?? 50
  const timeout = opts.claimTimeoutMs ?? 30_000

  const table  = outboxTable(db)
  const now    = new Date()
  const stale  = new Date(now.getTime() - timeout)

  const owed = await table.findMany({
    where:   { deliveredAt: null, OR: [{ claimedAt: null }, { claimedAt: { lt: stale } }] },
    orderBy: { createdAt: 'asc' },
    limit:   batch,
  })

  let delivered = 0
  let failed    = 0

  for (const row of owed) {
    // Compare-and-set on the claim we read. Two relays over one database — two
    // app processes, or a sweep overlapping a post-commit kick — both see the
    // row, and only the one whose UPDATE matches takes it.
    const claimed = await table.updateMany({
      where: { id: row.id, deliveredAt: null, claimedAt: row.claimedAt },
      data:  { claimedAt: now, attempts: row.attempts + 1 },
    })
    if (claimed.count !== 1) continue

    try {
      // The tenant travels with the work, because the handler's own writes go
      // back to the database this row came out of. Under `strategy database`
      // that is a different FILE, so a dispatch that named no tenant would run
      // the effect against the app's own — which is nobody's.
      await jobs.dispatch(row.job, row.payload, {
        id:    occurrenceKey('outbox', row.id),
        actor: row.actorId,
        ...(tenant !== null ? { tenant } : {}),
      })
      await table.update({ where: { id: row.id }, data: { deliveredAt: new Date() } })
      delivered++
    } catch (err) {
      // Release the claim so the next pass retries rather than waiting out the
      // stale-claim timeout. `attempts` is already counted and stays counted.
      failed++
      await table.update({
        where: { id: row.id },
        data:  { claimedAt: null, lastError: (err as Error)?.message ?? String(err) },
      })
    }
  }

  return { delivered, failed }
}

/** Drop delivered rows past their retention. They are kept for inspection. */
export async function sweepOutbox(app: App, retentionMs: number): Promise<number> {
  const before = new Date(Date.now() - retentionMs)

  let gone = 0
  for (const { db } of await outboxDatabases(app)) {
    const removed = await outboxTable(db).removeMany({
      where: { deliveredAt: { lt: before, not: null } },
    })
    gone += removed.count
  }
  return gone
}

/**
 * Refuse a shape the relay cannot resolve, at boot.
 *
 * The relay's own pass logs and continues — an intermittent database error is
 * not a reason to take the process down — so a misconfiguration discovered
 * there would be one line in a log and a queue that never drains. This is the
 * same question asked where it can still be a refusal.
 */
export async function assertOutboxShape(app: App): Promise<void> {
  await outboxDatabases(app)
}

/** Rows owed, across every database this app writes them to. */
export async function pendingOutbox(app: App): Promise<number> {
  let pending = 0
  for (const { db } of await outboxDatabases(app))
    pending += await outboxTable(db).count({ where: { deliveredAt: null } })
  return pending
}

// ─── What the plugin claims ───────────────────────────────────────────────────

/** `app.outbox`. Present only when `app.configure(outbox())` installed it. */
export interface OutboxApi {
  /** Run one delivery pass now. The relay's own timer calls this. */
  deliver(opts?: DeliverOptions): Promise<DeliverResult>
  /** Drop delivered rows past their retention. Answers how many went. */
  sweep(retentionMs?: number): Promise<number>
  /** How many rows are still owed. For a health endpoint, and for tests. */
  pending(): Promise<number>
}

// ─── The shipped schema fragment ──────────────────────────────────────────────

/**
 * `db/outbox.lite`, for an app that assembles its schema as ONE STRING in
 * memory rather than importing the file from `schema.lite`.
 *
 * The same two ways in that `@frontierjs/auth` offers, and for the same reason:
 * `fli outbox:install` writes an `import` line into the app's own schema, and
 * this is what an app building the text itself calls instead. Same bytes both
 * ways — a hand copy is what drifts.
 *
 * `database` retargets `@@db(main)`, which is what `import … into <db>` does on
 * the other path. Anchored to the line: the file discusses the attribute in its
 * own header, and a bare substring replace rewrites that prose too.
 */
export function outboxSchemaFragment(database = 'main'): string {
  const text = readFileSync(new URL('../../db/outbox.lite', import.meta.url), 'utf8')
  return database === 'main'
    ? text
    : text.replace(/^([ \t]*)@@db\(main\)/gm, `$1@@db(${database})`)
}
