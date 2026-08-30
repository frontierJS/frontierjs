// core/backfill.ts
// The middle step of expand → backfill → contract.
//
// `litestone release` refuses a contract on a required column and hands back a
// three-step plan. The first and third steps are deploys and the classifier
// already grades them; the second was a sentence — *fill `x` for the rows that
// predate it* — sitting between two commands. Offering a split whose middle
// step is a hand-written script is worse than not classifying the pivot at all,
// because the refusal implies there is a supported alternative.
//
// Filling a column for ten million rows is not a migration and the migration
// runner must not become one: a migration is a schema change applied once
// inside a transaction, and that definition is worth keeping. What a backfill
// needs instead — pgroll has already paid for this list — is to be idempotent,
// resumable after an interruption, chunked, checkpointed, and throttled against
// live traffic.
//
// Four of the five come out of the shape rather than being built. The row in
// `db/backfill.lite` is the checkpoint; Caravan's queue makes each chunk a
// durable, retried unit; `dispatch({ id })` keyed on the cursor makes a replay
// a no-op. **Idempotence is the predicate, not the cursor**: a chunk re-reads
// `field IS NULL`, so a row an interrupted chunk already filled is skipped
// whatever position the row records. The cursor is an optimisation.
//
// Throttling is the one thing that is a build, and it is deliberately measured
// on this side of the wire — see `nextDelayMs`.
//
// **This is a cursor over one table and it is not a durable workflow.** The
// deploy journal is the other thing here that records progress durably, and
// two narrow mechanisms that look alike are not yet a primitive
// (`IDEAS/overview.md` 4.19 stays where it is). Nothing in this file is
// general: there are no steps, no compensation, and no point past which it can
// only go forward.

import { occurrenceKey } from '@frontierjs/toolbelt/history'
import { readFileSync } from 'node:fs'

import type { App } from './app.ts'

/** The model `packages/junction/db/backfill.lite` declares, and its accessor. */
export const BACKFILL_MODEL    = 'BackfillRun'
export const BACKFILL_ACCESSOR = 'backfillRun'

/** The caravan job one chunk runs as. */
export const BACKFILL_JOB = 'junction:backfill'

// ─── The declaration ─────────────────────────────────────────────────────────

export interface BackfillDefinition<Row = Record<string, unknown>> {
  /** Marker the autoloader uses to tell a backfill file's export from anything else. */
  __junctionBackfill: true
  name:      string
  model:     string
  field:     string
  chunkSize: number
  duty:      number
  where:     Record<string, unknown> | null
  fill:      (row: Row) => unknown
}

export interface BackfillOptions<Row = Record<string, unknown>> {
  /**
   * This backfill's identity. Re-running RESUMES it rather than starting a
   * second, so the name is the primary key of its row and there is no separate
   * run id — there is no second run to tell apart.
   */
  name:  string
  /** The model whose rows are filled, PascalCase as the schema declares it. */
  model: string
  /**
   * The column being filled. Named rather than inferred from `fill`, because
   * `litestone release` reads it: a contract on `Order.shippedAt` can only be
   * graded against a backfill that says which column it fills.
   */
  field: string
  /**
   * The value for one row. `undefined` declines it — a legitimate answer, and
   * counted as scanned rather than filled.
   *
   * Rows are grouped by the value this returns and written with `updateMany`,
   * which is the only write that takes `announce`. A per-row `update` would
   * broadcast the whole row to every subscriber, once per row.
   */
  fill:  (row: Row) => unknown

  /**
   * Which rows are still owed. Default `{ [field]: null }`, which is the shape
   * the expand → contract split produces and the shape that makes a chunk
   * self-limiting.
   *
   * **A custom predicate must exclude the rows this backfill has already
   * filled**, or a retried chunk does its work twice and the run never ends.
   * That is the whole of what makes the default safe.
   */
  where?: Record<string, unknown>

  /** Rows per chunk. Default 500. */
  chunkSize?: number
  /**
   * The fraction of wall time this backfill may spend working. Default 0.25 —
   * a chunk that took 200ms waits 600ms before the next one.
   */
  duty?: number
}

export function defineBackfill<Row = Record<string, unknown>>(
  opts: BackfillOptions<Row>
): BackfillDefinition<Row> {
  for (const key of ['name', 'model', 'field'] as const)
    if (!opts?.[key]) throw new Error(`[Junction] defineBackfill(): '${key}' is required`)
  if (typeof opts.fill !== 'function')
    throw new Error(`[Junction] defineBackfill('${opts.name}'): 'fill' must be a function`)

  const duty = opts.duty ?? 0.25
  if (!(duty > 0 && duty <= 1))
    throw new Error(`[Junction] defineBackfill('${opts.name}'): 'duty' must be greater than 0 and at most 1 — got ${duty}`)

  const chunkSize = opts.chunkSize ?? 500
  if (!Number.isInteger(chunkSize) || chunkSize < 1)
    throw new Error(`[Junction] defineBackfill('${opts.name}'): 'chunkSize' must be a positive integer — got ${chunkSize}`)

  return {
    __junctionBackfill: true,
    name:  opts.name,
    model: opts.model,
    field: opts.field,
    where: opts.where ?? null,
    fill:  opts.fill,
    chunkSize,
    duty,
  }
}

export const isBackfillDefinition = (v: unknown): v is BackfillDefinition =>
  !!v && typeof v === 'object' && (v as { __junctionBackfill?: unknown }).__junctionBackfill === true

// ─── The throttle ────────────────────────────────────────────────────────────

/**
 * How long to wait before the next chunk.
 *
 * A duty cycle, computed from the chunk that just ran: a backfill that is
 * costing more slows down in proportion, without anything measuring the
 * database. **What it does not measure is stated rather than implied** — the
 * signal is this backfill's own latency, so it responds to contention it is
 * part of and is blind to load that does not touch these rows. `busy_timeout`
 * is a PRAGMA, so SQLite swallows the retries and only wall time is visible
 * from here at all (`FJS-D155`).
 *
 * `paused` on the row is the throttle of last resort and this is not it.
 */
export const nextDelayMs = (chunkMs: number, duty: number): number =>
  Math.max(0, Math.round(chunkMs * (1 / duty - 1)))

// ─── The client ──────────────────────────────────────────────────────────────

/** A Litestone client, minus every model — this module names exactly one. */
interface BackfillClient {
  $schema?: { models?: Array<{ name: string; fields?: Array<{ name: string; type?: unknown; attributes?: Array<{ kind?: string }> }> }> }
  asSystem(): BackfillClient
  [accessor: string]: unknown
}

export interface BackfillRow {
  name:        string
  modelName:   string
  fieldName:   string
  cursor:      string | null
  scanned:     number
  filled:      number
  status:      'pending' | 'running' | 'done' | 'failed' | 'paused'
  generation:  number
  chunkSize:   number
  lastChunkMs: number | null
  attempts:    number
  lastError:   string | null
  startedAt:   string | null
  finishedAt:  string | null
}

interface Table {
  findFirst(args:  { where: Record<string, unknown> }): Promise<Record<string, unknown> | null>
  findMany(args:   { where?: Record<string, unknown>; orderBy?: Record<string, unknown>; limit?: number }): Promise<Array<Record<string, unknown>>>
  createMany(args: { data: Array<Record<string, unknown>>; announce?: string }): Promise<{ count: number }>
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown>; announce?: string }): Promise<{ count: number }>
}

/**
 * Every write this feature makes, including its own bookkeeping.
 *
 * `announce` is a BULK option — a single `update` has none and always fires —
 * so the run row is written through `updateMany` on its own primary key, which
 * touches exactly one row and says nothing. Without it a backfill's progress
 * updates announce three times per chunk, which over twenty thousand chunks is
 * sixty thousand events about this package's own bookkeeping on the
 * application's stream.
 */
const SILENT = { announce: 'none' } as const

const tableOf = (db: BackfillClient, accessor: string): Table =>
  (db.asSystem() as unknown as Record<string, Table>)[accessor]

export const hasBackfillModel = (db: unknown): boolean =>
  !!(db as BackfillClient | undefined)?.$schema?.models?.some(m => m.name === BACKFILL_MODEL)

/**
 * The one database a backfill runs against.
 *
 * Under `createApp({ tenants })` with `strategy database` each tenant is a
 * separate FILE with its own rows and its own `BackfillRun`, so a backfill
 * there is N independent backfills carrying a tenant through the queue. That is
 * not built, and it is refused by name rather than run against the app's own
 * database — which is nobody's, and would report a completed backfill having
 * touched no tenant's rows.
 */
function backfillDb(app: App): BackfillClient {
  const registry = (app as { tenants?: unknown }).tenants
  if (registry) throw new Error(
    `[Junction] backfill: this app was built with createApp({ tenants }), where each ` +
    `tenant has its own rows and its own ${BACKFILL_MODEL}. Running one backfill against ` +
    `the app-level database would fill nobody's rows and report success. Per-tenant ` +
    `backfills are not built yet — fill the column with a migration per tenant, or open one.`
  )

  const db = app.db as BackfillClient | undefined
  if (!db) throw new Error('[Junction] backfill: this app has no database')
  if (!hasBackfillModel(db)) throw new Error(
    `[Junction] backfill: this schema declares no ${BACKFILL_MODEL}. ` +
    `Run 'fli backfill:install' to import db/backfill.lite.`
  )
  return db
}

// ─── What the target model's id is ───────────────────────────────────────────

export interface IdInfo { field: string; numeric: boolean }

/**
 * The model's own id column, and whether it holds a number.
 *
 * A cursor is stored as TEXT because a model's id may be a uuid or an integer
 * and one column holds both; reading it back has to know which, or `id > '999'`
 * compares an integer against a string and the scan silently returns nothing.
 */
export function idInfoFor(db: BackfillClient, model: string): IdInfo {
  const m = db.$schema?.models?.find(x => x.name === model)
  if (!m) throw new Error(`[Junction] backfill: this schema declares no model '${model}'`)

  const idField = m.fields?.find(f => f.attributes?.some(a => a.kind === 'id'))
  if (!idField) throw new Error(`[Junction] backfill: '${model}' declares no @id, so there is nothing to page by`)

  const type = (idField.type as { name?: string } | undefined)?.name
  return { field: idField.name, numeric: type === 'Int' || type === 'BigInt' }
}

/**
 * Refuse a column this model does not declare.
 *
 * Nothing below would: a `where` naming an unknown key warns to stderr and
 * returns NO ROWS, so a backfill with a typo in `field` scans an empty result,
 * reads the short chunk as the end, and marks itself **done** having filled
 * nothing. Silently wrong is the one outcome a backfill must not have — the
 * whole point of it is that a later contract can rely on it.
 */
export function assertField(db: BackfillClient, model: string, field: string): void {
  const m = db.$schema?.models?.find(x => x.name === model)
  if (!m) throw new Error(`[Junction] backfill: this schema declares no model '${model}'`)
  if (m.fields?.some(f => f.name === field)) return

  const names = (m.fields ?? []).map(f => f.name)
  throw new Error(
    `[Junction] backfill: '${model}' declares no field '${field}'. ` +
    `A filter naming an unknown column matches no rows, so this backfill would ` +
    `report itself finished having filled nothing. It declares: ${names.join(', ')}`)
}

export const decodeCursor = (text: string | null, id: IdInfo): unknown =>
  text == null ? null : id.numeric ? Number(text) : text

/** The accessor for a model name, which is its camelCase spelling. */
export const accessorFor = (model: string): string => model.charAt(0).toLowerCase() + model.slice(1)

// ─── The run row ─────────────────────────────────────────────────────────────

/** The row for this backfill, created on first sight. Answers it either way. */
export async function ensureRun(app: App, def: BackfillDefinition): Promise<BackfillRow> {
  const table = tableOf(backfillDb(app), BACKFILL_ACCESSOR)
  const found = await table.findFirst({ where: { name: def.name } })
  if (found) return found as unknown as BackfillRow

  // Two replicas booting together both find no row and both create it; the name
  // is the primary key, so one gets a conflict. Re-read rather than refuse —
  // the row the other one wrote is the row this one wanted.
  try {
    await table.createMany({
      data: [{
        name: def.name, modelName: def.model, fieldName: def.field,
        chunkSize: def.chunkSize, status: 'pending',
      }],
      ...SILENT,
    })
  } catch (err) {
    const raced = await table.findFirst({ where: { name: def.name } })
    if (!raced) throw err
    return raced as unknown as BackfillRow
  }
  return await table.findFirst({ where: { name: def.name } }) as unknown as BackfillRow
}

/** Every backfill this database knows about. What `/metrics` and a status command read. */
export async function backfillStatus(app: App): Promise<BackfillRow[]> {
  const table = tableOf(backfillDb(app), BACKFILL_ACCESSOR)
  return await table.findMany({ orderBy: { name: 'asc' } }) as unknown as BackfillRow[]
}

// ─── One chunk ───────────────────────────────────────────────────────────────

export interface ChunkResult {
  /** Nothing left to do — the scan came back short. */
  done:      boolean
  scanned:   number
  filled:    number
  /** Wall time the chunk cost, which is what the next delay is computed from. */
  ms:        number
  /** The position to resume from, already recorded on the row. */
  cursor:    string | null
  /** Set when the run is `paused`: nothing was scanned and nothing is owed. */
  paused?:   boolean
}

/**
 * Scan, fill, advance.
 *
 * The writes are grouped by VALUE and issued as `updateMany`, which is the only
 * write litestone lets a caller silence: a per-row `update` announces the whole
 * row to every subscriber, and a backfill over ten million rows would broadcast
 * ten million times. A group of one is still an `updateMany` — one statement,
 * and silent.
 *
 * `asSystem()` because a backfill is the application writing its own column and
 * has no principal behind it. That drops the gate, the row policies and the
 * field guards, and it does NOT drop a `@check` or a `@@check` — those are in
 * the table, so SQLite refuses a bad backfill exactly as it refuses anyone
 * (`FJS-519`).
 */
export async function runChunk(app: App, def: BackfillDefinition): Promise<ChunkResult> {
  const db    = backfillDb(app)
  const runs  = tableOf(db, BACKFILL_ACCESSOR)
  const row   = await ensureRun(app, def)

  if (row.status === 'paused') return { done: false, paused: true, scanned: 0, filled: 0, ms: 0, cursor: row.cursor }
  if (row.status === 'done')   return { done: true,  scanned: 0, filled: 0, ms: 0, cursor: row.cursor }

  const id    = idInfoFor(db, def.model)
  assertField(db, def.model, def.field)
  const table = tableOf(db, accessorFor(def.model))
  const owed  = def.where ?? { [def.field]: null }
  const after = decodeCursor(row.cursor, id)

  const started = Date.now()

  if (row.status !== 'running')
    await runs.updateMany({ where: { name: def.name }, data: { status: 'running', startedAt: row.startedAt ?? new Date() }, ...SILENT })

  const rows = await table.findMany({
    where:   { ...owed, ...(after == null ? {} : { [id.field]: { gt: after } }) },
    orderBy: { [id.field]: 'asc' },
    limit:   def.chunkSize,
  })

  // Grouped by the VALUE the fill answered. `JSON.stringify` is the key rather
  // than the value itself because a Date and a number are different rows of one
  // group only if they compare by content — and two Dates for one instant are
  // not `===`.
  const groups = new Map<string, { value: unknown; ids: unknown[] }>()
  let scanned  = 0

  for (const r of rows) {
    scanned++
    const value = await def.fill(r as Record<string, unknown>)
    if (value === undefined) continue
    const key = JSON.stringify(value) ?? 'undefined'
    const g   = groups.get(key) ?? { value, ids: [] }
    g.ids.push(r[id.field])
    groups.set(key, g)
  }

  let filled = 0
  for (const { value, ids } of groups.values()) {
    const written = await table.updateMany({
      where:    { [id.field]: { in: ids } },
      data:     { [def.field]: value },
      announce: 'none',
    })
    filled += written.count
  }

  const ms     = Date.now() - started
  // The LAST row scanned, not the last one written — a row the fill declined is
  // still behind us, and a cursor that only moved past writes would re-read it
  // on every chunk for the rest of the run.
  const cursor = rows.length ? String(rows[rows.length - 1][id.field]) : row.cursor
  const done   = rows.length < def.chunkSize

  await runs.updateMany({
    where: { name: def.name },
    ...SILENT,
    data: {
      cursor,
      scanned:     row.scanned + scanned,
      filled:      row.filled  + filled,
      lastChunkMs: ms,
      status:      done ? 'done' : 'running',
      ...(done ? { finishedAt: new Date() } : {}),
    },
  })

  return { done, scanned, filled, ms, cursor }
}

/** Record a chunk that threw. The queue's own ladder decides whether to retry. */
export async function recordFailure(app: App, def: BackfillDefinition, err: unknown): Promise<void> {
  const runs = tableOf(backfillDb(app), BACKFILL_ACCESSOR)
  const row  = await ensureRun(app, def)
  await runs.updateMany({
    where: { name: def.name },
    data:  { status: 'failed', attempts: row.attempts + 1, lastError: (err as Error)?.message ?? String(err) },
    ...SILENT,
  })
}

// ─── The chunk id ────────────────────────────────────────────────────────────

/**
 * *This exact chunk has already been queued.*
 *
 * The cursor is in the key, so two dispatches of the same position are one row
 * — which is what makes a boot that starts every unfinished backfill safe in a
 * second replica, and what makes the re-dispatch at the end of a chunk safe to
 * run twice. `occurrenceKey` because a name and a cursor joined by hand share
 * one namespace with every id a caller states (`FJS-342`).
 *
 * **The generation is in it and has to be**, because `dispatch({ id })` treats a
 * taken primary key as work already queued FOR ALL TIME. A chunk that ran and
 * declined — the run was paused under it — holds its id forever, so without a
 * term that moves, resuming is not slow but impossible, and the recovery sweep
 * cannot restart a run the queue gave up on either.
 */
export const chunkId = (name: string, generation: number, cursor: string | null): string =>
  occurrenceKey('backfill', name, String(generation), cursor ?? '')

// ─── The shipped schema fragment ─────────────────────────────────────────────

/**
 * `db/backfill.lite`, for an app that assembles its schema as ONE STRING in
 * memory rather than importing the file from `schema.lite`. Same two ways in
 * that `@frontierjs/auth` and the outbox offer, and the same reason: a hand
 * copy is what drifts.
 */
export function backfillSchemaFragment(database = 'main'): string {
  const text = readFileSync(new URL('../../db/backfill.lite', import.meta.url), 'utf8')
  return database === 'main'
    ? text
    : text.replace(/^([ \t]*)@@db\(main\)/gm, `$1@@db(${database})`)
}
