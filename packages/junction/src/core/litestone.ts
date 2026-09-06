// core/litestone.ts
// Litestone adapter — Junction's base service implementation backed by
// @frontierjs/litestone. Translates Feathers-style query params to Litestone's
// query shape and builds an enhanced client per-request so @@allow policies
// enforce per-user.
//
// Design notes:
//
//   • Telemetry: Litestone exposes both a global `onQuery` (passed to
//     createClient) and a per-client `$tapQuery(fn)` that returns an unsub
//     function. We register a tap once per request (cached on ctx.locals),
//     enrich the event with telemetryId + isSystem, and emit on
//     app.telemetry. The unsub is queued on ctx._cleanups for the
//     callService finally block.
//
//   • Soft delete: When a Litestone model declares `@@softDelete`, the
//     runtime filters deleted rows automatically and `remove()` does the soft
//     stamp. The adapter's `softDelete` option is a Junction-side override
//     for models whose schemas don't use @@softDelete (rare). Default: trust
//     the schema.
//
//   • Bulk return shapes: Litestone's createMany / updateMany / deleteMany
//     return `{ count: N }`. The adapter passes that shape through unchanged
//     — callers should be aware bulk operations don't return arrays of
//     records (use individual create() calls if you need echo of stamped
//     fields).

import { createSchema } from './schema.ts'
import type { Schema, FieldDef } from './schema.ts'
import { createService, createBaseService } from './service.ts'
import type { CacheDeclaration } from './service.ts'
import type { HookMap } from './hooks.ts'
import { NotFound, BadRequest, Unauthorized, Forbidden } from './errors.ts'
import { fieldError } from './field-errors.ts'
import type { ServiceContext, QueryDirectives } from './context.ts'
import { clampPage } from './directives.ts'
import { announcingService, announcedInCommitScope, freezeUser, requestMeta, currentCall } from './context.ts'
import { toBulkFailure, partitionBulk, BULK_FAILURES, type BulkFailure } from './envelope.ts'
import { singularize } from '@frontierjs/toolbelt/inflect'
import { gradeStanding, levelPasses, LEVELS } from '@frontierjs/toolbelt/gate'
import type { GradableUser } from '@frontierjs/toolbelt/gate'
import { normalizeOrderBy, type SortParam } from './sort.ts'

// Module augmentation: typing ctx.locals.db without forcing a hard
// Litestone dependency on junction core. Apps using the litestone
// integration get ctx.locals.db typed; others don't pay for it.
declare module './context.ts' {
  interface ServiceContextLocals {
    db?: LitestoneClient
  }
}

// ─── Litestone client interface ──────────────────────────────────────────
// Minimal surface used by this adapter. The real type comes from
// @frontierjs/litestone but we avoid a hard import so the adapter compiles
// without Litestone installed.

interface LitestoneTable {
  findMany:         (args?: Record<string, unknown>) => Promise<unknown[]>
  findManyAndCount: (args?: Record<string, unknown>) => Promise<{ rows: unknown[]; total: number }>
  findFirst:        (args?: Record<string, unknown>) => Promise<unknown | null>
  findUnique:       (args:  Record<string, unknown>) => Promise<unknown | null>
  count:            (args?: Record<string, unknown>) => Promise<number>
  create:           (args:  Record<string, unknown>) => Promise<unknown>
  createMany:       (args:  Record<string, unknown>) => Promise<{ count: number }>
  update:           (args:  Record<string, unknown>) => Promise<unknown>
  updateMany:       (args:  Record<string, unknown>) => Promise<{ count: number }>
  remove:           (args:  Record<string, unknown>) => Promise<unknown>     // soft on @@softDelete, hard otherwise
  removeMany:       (args:  Record<string, unknown>) => Promise<{ count: number }>
  delete:           (args:  Record<string, unknown>) => Promise<unknown>     // always hard
  deleteMany:       (args:  Record<string, unknown>) => Promise<{ count: number }>
  restore:          (args:  Record<string, unknown>) => Promise<unknown>     // @@softDelete models only
  search:           (query: string, args?: Record<string, unknown>) => Promise<unknown[]>  // @@fts models only — the ROWS, ranked
  // The window (`FJS-D145`). Optional because a litestone that predates them
  // simply answers no cursor, and offset carries on as it always did.
  findManyCursor?:  (args?: Record<string, unknown>) =>
    Promise<{ items: unknown[]; nextCursor: string | null; hasMore: boolean }>
  cursorFor?:       (row: unknown, orderBy?: unknown) => string | null
  /** The caller's ordering plus whatever makes it total; `null` where no tie
   *  can be broken, which is a list that cannot carry a window. */
  orderTotal?:      (orderBy?: unknown) => unknown[] | null
}

// Split into the client's own API and the table it answers per model, then
// intersected — because an interface's declared members must satisfy its index
// signature, and `asSystem(): LitestoneClient` is not a table. With one
// interface the signature had to be `[model: string]: unknown`, so an app got
// `asSystem()` typed and `ctx.locals.db.post.findMany()` as `unknown` — which
// is every actual data call, and is why an app writes `dbOf(ctx): any` and
// takes the whole client's safety with it (FJS-370).
//
// `LitestoneTable | unknown` is not the fix and looks like it: a union with
// `unknown` collapses to `unknown` (FJS-034 found the same thing on
// `ServiceDefinition`).
//
// The cost is that any accessor name resolves, so `db.pots.findMany()`
// compiles. That trade is made knowing where the answer is: a Litestone client
// THROWS on an unknown property, so a typo is loud on the first call, and an
// app wanting it at compile time generates its own types (`litestone types`)
// and augments. Answering `unknown` here bought nothing for the typo and cost
// every correct call.

interface LitestoneClientApi {
  asSystem(): LitestoneClient
  $setAuth(user: unknown): LitestoneClient
  $tapQuery(fn: (event: LitestoneQueryEvent) => void): () => void
  $transaction?: <T>(fn: (tx: LitestoneClient) => Promise<T>) => Promise<T>
  $schema?: unknown
  $rawDbs?: Record<string, unknown>
  $close?: () => void
}

type LitestoneClient = LitestoneClientApi & { [model: string]: LitestoneTable }

export interface LitestoneQueryEvent {
  model: string
  operation: string
  database: string
  actorId: string | number | null
  sql: string
  params: unknown[]
  duration: number
  rowCount: number
  args: Record<string, unknown>
  telemetryId?: string
  isSystem?: boolean
}

/**
 * What `$tapEvents` delivers — `onEvent`'s payload plus the event NAME, which a
 * subscriber needs because a `transition` carries no `operation`.
 */
export interface LitestoneWriteEvent {
  event:  'create' | 'update' | 'remove' | 'transition'
  model:  string
  result?: unknown
  /**
   * Whether this event is about ONE row or a filter's worth of them. Stated by
   * Litestone rather than inferred here, because `result: null` is not one fact:
   * a `select: false` write is row-scoped and has no row to hand over, and a
   * bulk statement never built the rows at all. Absent on a client predating
   * this, where every event was row-scoped and carried its row.
   */
  scope?:  'row' | 'collection'
  count?:  number
  /** The caller's filter, on a collection event. In-process only — see below. */
  where?:  unknown
  /** `transition` only: the move's own name (`pay`), which is what it
   *  announces under — the same name the service call would have used. */
  transition?: string
  /** `transition` only: the row after the move. `result` is the CRUD events'
   *  name for the same thing; they are two keys because Litestone builds the
   *  two payloads in two places and this side must not guess which it got. */
  record?: unknown
  [k: string]: unknown
}

const OPS: Record<string, string> = {
  $in:     'in',
  $nin:    'notIn',
  $lt:     'lt',
  $lte:    'lte',
  $gt:     'gt',
  $gte:    'gte',
  $ne:     'not',
  $like:   'contains',
  $start:  'startsWith',
  $end:    'endsWith',
}

export interface ParsedQuery {
  where: Record<string, unknown>
  orderBy?: Record<string, 'asc' | 'desc'>[]
  offset: number
  limit:  number
  after?: string    // $after — the window's far edge, opaque (`FJS-D145`)
  select?: Record<string, boolean>
  include?: Record<string, boolean | { select: Record<string, boolean> }>
  search?:         string    // $search — FTS5 via table.search()
  withDeleted?:    boolean   // $withDeleted — include soft-deleted rows
  onlyDeleted?:    boolean   // $onlyDeleted — show only soft-deleted rows
  withTemplates?:  boolean   // $withTemplates — include @@hasTemplates rows
  onlyTemplates?:  boolean   // $onlyTemplates — show only @@hasTemplates rows
}

/**
 * Filters + directives → a Litestone query.
 *
 * `query` is filters only; `directives` is the structured form of what arrived
 * on the wire as `$limit`/`$offset`/…. The two used to be one object, and the
 * bridge stripped exactly the four keys this function destructured — so
 * pagination, ordering and field selection were all inert over HTTP.
 *
 * The `$`-in-query path is kept as a fallback for callers that predate
 * ctx.directives (direct parseQuery() users, older internal calls). Explicit
 * directives always win.
 */
export function parseQuery(
  query: Record<string, unknown>,
  defaultLimit = 20,
  maxLimit = 100,
  directives: QueryDirectives = {}
): ParsedQuery {
  const { $limit, $offset, $after, $orderBy, $select, $populate,
          $search, $withDeleted, $onlyDeleted,
          $withTemplates, $onlyTemplates, ...where } = query

  const limitRaw   = directives.limit       ?? $limit
  const offsetRaw  = directives.offset      ?? $offset
  const afterRaw   = directives.after       ?? $after
  const orderByRaw = directives.orderBy     ?? $orderBy
  const selectRaw  = directives.select      ?? $select
  const popRaw     = directives.populate    ?? $populate
  const searchRaw  = directives.search      ?? $search
  const withDel    = directives.withDeleted ?? $withDeleted
  const onlyDel    = directives.onlyDeleted ?? $onlyDeleted
  const withTmpl   = directives.withTemplates ?? $withTemplates
  const onlyTmpl   = directives.onlyTemplates ?? $onlyTemplates

  // What a limit and an offset mean is `clampPage`'s answer, not this
  // function's — the `paginate()` hook needs the same one and had its own.
  const { limit, offset } = clampPage(
    { limit: limitRaw as number, offset: offsetRaw as number },
    defaultLimit, maxLimit,
  )

  return {
    where:        parseWhere(where),
    orderBy:      orderByRaw != null ? parseSort(orderByRaw as SortParam) : undefined,
    offset,
    limit,
    after:        typeof afterRaw === 'string' && afterRaw !== '' ? afterRaw : undefined,
    select:       selectRaw  != null ? parseSelect(selectRaw as SelectParam) : undefined,
    include:      popRaw     != null ? parsePopulate(popRaw as PopulateParam) : undefined,
    search:       typeof searchRaw === 'string' ? searchRaw : undefined,
    withDeleted:   withDel  === true || withDel  === 'true' || undefined,
    onlyDeleted:   onlyDel  === true || onlyDel  === 'true' || undefined,
    withTemplates: withTmpl === true || withTmpl === 'true' || undefined,
    onlyTemplates: onlyTmpl === true || onlyTmpl === 'true' || undefined,
  }
}

export function parseWhere(query: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [key, val] of Object.entries(query)) {
    if (key === '$or' && Array.isArray(val)) {
      result['OR'] = val.map((v) => parseWhere(v as Record<string, unknown>))
      continue
    }
    if (key === '$and' && Array.isArray(val)) {
      result['AND'] = val.map((v) => parseWhere(v as Record<string, unknown>))
      continue
    }
    if (key === '$not' && typeof val === 'object' && val !== null) {
      result['NOT'] = parseWhere(val as Record<string, unknown>)
      continue
    }

    if (typeof val === 'object' && val !== null && '$null' in (val as object)) {
      result[key] = (val as { $null: boolean }).$null ? null : { not: null }
      continue
    }

    if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
      const ops = val as Record<string, unknown>
      const hasOps = Object.keys(ops).some((k) => k.startsWith('$'))
      if (hasOps) { result[key] = translateOps(ops); continue }
      result[key] = parseWhere(ops)
      continue
    }

    result[key] = val
  }

  return result
}

function translateOps(ops: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [op, val] of Object.entries(ops)) {
    if (op === '$ilike') {
      result['contains'] = typeof val === 'string' ? val.toLowerCase() : val
      continue
    }
    const litestoneOp = OPS[op]
    if (!litestoneOp) { result[op] = val; continue }
    result[litestoneOp] = val
  }

  return result
}

// The spellings are `core/sort.ts`'s, because the browser client asks the same
// question of the same value — it has to place a pushed row in a list it cannot
// re-query — and two readings of `-createdAt` is two orders for one list.
const parseSort = normalizeOrderBy

type SelectParam = string | string[]

function parseSelect(select: SelectParam): Record<string, boolean> {
  const fields = Array.isArray(select) ? select : select.split(',')
  return fields.reduce(
    (acc, f) => ({ ...acc, [f.trim()]: true }),
    {} as Record<string, boolean>
  )
}

type PopulateParam = string | string[]

function parsePopulate(
  populate: PopulateParam
): Record<string, boolean | { select: Record<string, boolean> }> {
  const relations = Array.isArray(populate) ? populate : populate.split(',')
  const result: Record<string, boolean | { select: Record<string, boolean> }> = {}

  for (const rel of relations.map(r => r.trim())) {
    const colonIdx = rel.indexOf(':')
    if (colonIdx === -1) {
      result[rel] = true   // already trimmed above
    } else {
      const name = rel.slice(0, colonIdx).trim()
      const fields = rel.slice(colonIdx + 1).split('+').map((f) => f.trim())
      result[name] = { select: parseSelect(fields) }
    }
  }

  return result
}

/**
 * A service name → the model it answers for. `postsService` and `posts` both
 * give `post`.
 *
 * The `Service` suffix and the camelCase are junction's business; the
 * inflection is not, and this used to carry its own copy of the rules —
 * `ies`/`ses` and no irregular table at all, so a `people` service resolved to
 * `people` and its model was never found. Litestone derives a table name with
 * the same rules run the other way (Invariant 2), which only holds while there
 * is one copy of them.
 */
export function deriveModelName(name: string): string {
  const clean = name.replace(/Service$/i, '')
  const camel = clean.charAt(0).toLowerCase() + clean.slice(1)
  return singularize(camel)
}

/**
 * Accessor spellings to try, in precedence order.
 *
 * A FrontierJS app names one model three ways: `model Post` in the .lite file,
 * `posts` for the service (from the filename, and the URL), and `db.post` for
 * the Litestone accessor. Three places resolve an accessor against a client —
 * getTable (the query), _gateLevels (@@gate auth) and resolveDefsKey (field
 * validation) — and all three used to match the literal string only.
 *
 * That is worse than a lookup miss. getTable throws, but the other two FAIL
 * OPEN: a service declaring `model: 'posts'` against `model Post` found no gate
 * and no schema, so `@@gate("4")` silently permitted anonymous requests and
 * validation silently did nothing. Normalizing in one place is what keeps the
 * three consistent.
 *
 * The literal spelling always wins, so `@@external` models mirroring a
 * genuinely-plural foreign table keep resolving to themselves.
 */
export function accessorCandidates(accessor: string): string[] {
  const derived = deriveModelName(accessor)
  return derived === accessor ? [accessor] : [accessor, derived]
}

/**
 * The one spelling of an accessor a Litestone client will actually judge.
 *
 * `getTable` and `_gateLevels` each walk `accessorCandidates` themselves, so
 * they resolve `'orders'` → `db.order` and always have. The two derived hooks
 * that ASK the client a question — `$checkWhere`, `$checkOrderBy` — passed the
 * name through untouched, and both answer `[]` for an accessor they do not
 * know. `[]` also means *no problems*, so the answer to "is this filter valid"
 * and the answer to "which model is that" were indistinguishable, and the hooks
 * read *I cannot judge this* as *this is fine*.
 *
 * Measured on `example`, whose services declare no `model:` and are therefore
 * named for the URL: `GET /api/orders?bogusColumn=7` answered **200 with an
 * empty list** where it documents a 400. The sort half was hidden behind
 * Litestone's own backstop — it THROWS on a bad `orderBy` where a bad `where`
 * only warns to stderr — so one of the two looked correct while neither was.
 *
 * Resolves off `$schema` rather than probing, because probing cannot work:
 * there is no query whose answer separates the two meanings of `[]`.
 */
export function resolveAccessor(client: unknown, accessor: string): string {
  return accessorIfModel(client, accessor) ?? accessor
}

/**
 * The same walk, answering `null` where `resolveAccessor` answers the input.
 *
 * Two callers want different things from one lookup. A validator wants a name
 * to pass on and a miss is harmless, so it takes the input back. Anything
 * deciding whether a rule is APPLICABLE cannot use that answer — an accessor
 * that named no model is indistinguishable from one that named itself, and
 * `$readGrading` answers `graded` for an unknown accessor by design, so a
 * `webhook:test` event would be refused as if a policy had judged it.
 */
export function accessorIfModel(client: unknown, accessor: string): string | null {
  let models: Array<{ name: string }> | undefined
  // Reading an unknown property off a Litestone client throws by design, so
  // even a plain field read is a guarded one here (see autoFilter).
  try {
    models = (client as { $schema?: { models?: Array<{ name: string }> } })?.$schema?.models
  } catch { return null }
  if (!Array.isArray(models)) return null

  const candidates = accessorCandidates(accessor)
  const camel = (n: string) => n.charAt(0).toLowerCase() + n.slice(1)
  const model = models.find(m => candidates.includes(camel(m.name)))
  return model ? camel(model.name) : null
}

export interface LitestoneServiceOptions {
  /**
   * Litestone accessor for the model — `'post'` for `model Post`.
   *
   * Optional. When omitted the accessor is resolved at call time from the
   * service name, which the autoloader derives from the filename. That makes
   * the minimal service file literally just the model:
   *
   *   // services/posts.service.ts
   *   export function createPostsService() {
   *     return createBaseService({})       // → db.post, via 'posts'
   *   }
   *
   * A plural spelling resolves too (see accessorCandidates), so `'posts'`,
   * `'post'` and an omitted value all reach `model Post`.
   */
  model?:      string
  idField?:    string
  paginate?:   { default: number; max: number }
  softDelete?: string
  allowBulk?:  boolean
  /**
   * How many rows one filtered bulk patch/remove may touch. Default 1000.
   *
   * A filtered bulk write runs one statement per row (see `bulkByRow`), so
   * without a bound a single request can hold the write lock for the length of
   * the table. Over it, the call is refused naming the count.
   */
  bulkMax?:    number
}

// ─── findWindow ───────────────────────────────────────────────────────────

/** The list envelope a windowed read answers. `total` is null on the keyset
 *  path, where no COUNT was run. */
export interface WindowResult {
  total:     number | null
  limit:     number
  offset:    number
  data:      unknown[]
  endCursor: string | null
  hasMore:   boolean
}

/**
 * Run a list read and answer the window's far edge with it (`FJS-D145`).
 *
 * The one owner of the two paths a list can take. `after` present is the
 * keyset path — no OFFSET, no COUNT, the edge minted by the scan; absent is an
 * ordinary page, and the edge is minted from the last row it already holds, so
 * every list carries one and a caller that never grows a window pays nothing.
 *
 * Exported because the derived find is not the only find. A service that
 * assembles its own query — one that forces a tenant column, or narrows to the
 * filters it means to expose — used to have no way to answer `$after` short of
 * restating both branches, and a restatement is how the tiebreaker, the absent
 * total and the `offset` rule end up with two answers.
 *
 * `args` is the query as the caller built it, `limit`/`offset` included.
 * `label` names the list in the refusal, since this cannot see a model.
 */
export async function findWindow(
  table: LitestoneTable,
  args:  Record<string, unknown>,
  after?: string,
  label = 'This list',
): Promise<WindowResult> {
  const limit  = (args.limit  as number) ?? 0
  const offset = (args.offset as number) ?? 0

  if (after) {
    // A cursor and an offset never combine, and the cursor wins: it is the more
    // specific request, and the two together name no position either one means.
    const scan: Record<string, unknown> = { ...args, cursor: after }
    delete scan.offset
    if (typeof table.findManyCursor !== 'function') throw new BadRequest(
      `${label} cannot answer $after — this Litestone client has no cursor paging. ` +
      `Use $offset.`)
    const page = await table.findManyCursor(scan)
    // `total` is deliberately absent rather than guessed: no COUNT ran, and
    // reporting the page length as the total is what makes a list claim to be
    // complete every time it is capped.
    return {
      total: null, limit, offset: 0, data: page.items,
      endCursor: page.nextCursor, hasMore: page.hasMore,
    }
  }

  // The ordinary page — and it is walked in the SAME order the keyset scan
  // would walk it. Two rows tying on every sort key otherwise leave the page
  // ending wherever SQLite happened to stop, while the edge minted off that row
  // names where the total order says it stopped: the rows between the two are
  // lost, once per tie, and only ever under real data. The tiebreaker is the
  // schema's and is asked for rather than derived here.
  // Duck-typed, so a litestone that predates either method answers no cursor
  // and offset carries on exactly as it did.
  const ordered = typeof table.orderTotal === 'function' ? table.orderTotal(args.orderBy) : null
  const scan    = ordered ? { ...args, orderBy: ordered } : args

  const { rows, total } = await table.findManyAndCount(scan)
  // No total order, no window: a list whose ties cannot be broken has no edge
  // to name, and offering one would be the same silent loss from the other end.
  const endCursor = (offset === 0 && rows.length > 0 && ordered && typeof table.cursorFor === 'function')
    ? table.cursorFor(rows[rows.length - 1], ordered)
    : null
  return {
    total, limit, offset, data: rows,
    endCursor, hasMore: total > offset + rows.length,
  }
}

export function createLitestoneBase(opts: LitestoneServiceOptions) {
  const {
    model,
    idField    = 'id',
    paginate   = { default: 20, max: 100 },
    softDelete,
    allowBulk  = true,
    bulkMax    = 1000,
  } = opts

  // `model` is the DECLARED option and is undefined whenever a service relies on
  // the filename, which is the default the autoloader is built around — so every
  // 404 from a scaffolded service read `undefined with id=… not found`. The
  // fallback is the same one getTable resolves the accessor with.
  const modelLabel = (ctx: ServiceContext): string => model ?? ctx.service

  /**
   * The model's key columns, in key order, or [] where nothing can say.
   *
   * The accessor is resolved by PROBING, exactly as `getTable` does, because
   * `model` is optional and the spelling that resolves is the one the client
   * answers to. `$primaryKey` answers [] for an unknown accessor — the
   * `$check*` family's contract, where *I cannot judge this* is not *this is
   * wrong* — so the probe is safe and a client that predates it is a miss
   * rather than a throw.
   */
  function primaryKeyOf(ctx: ServiceContext): string[] {
    const db = ctx.locals?.db as { $primaryKey?: (a: string) => string[] } | undefined
    if (typeof db?.$primaryKey !== 'function') return []
    for (const candidate of accessorCandidates(model ?? ctx.service)) {
      try {
        const key = db.$primaryKey(candidate)
        if (key.length) return key
      } catch { /* not this spelling */ }
    }
    return []
  }

  function getTable(ctx: ServiceContext): LitestoneTable {
    const baseDb = ctx.locals.db as LitestoneClient | undefined

    if (!baseDb) {
      throw new Error(
        `No Litestone db client on ctx.locals.db — ` +
        `ensure withLitestoneDb is in your app around hooks`
      )
    }

    const SCOPED_KEY = '__litestoneScopedDb'
    if (!ctx.locals[SCOPED_KEY]) {
      // Redundant when withLitestoneDb installed the scoping (which
      // createApp({ db }) now does automatically) — $setAuth on an already
      // scoped client returns an equivalent one. Kept so a hand-wired app that
      // seeds ctx.locals.db itself still gets scoping.
      //
      // $setAuth is guarded so plain (non-litestone) clients — adapted by
      // createBaseService — pass through without per-user scoping.
      const scopedDb: LitestoneClient = ctx.auth.user && typeof baseDb.$setAuth === 'function'
        ? baseDb.$setAuth(toDataPrincipal(ctx.auth.user))
        : baseDb

      // The query tap is NOT installed here. `$tapQuery` lives on the ROOT
      // client only, and reading it off a `$setAuth` proxy is not a miss — a
      // Litestone client THROWS on an unknown property, so
      // `typeof scopedDb.$tapQuery` was a throwing expression that turned every
      // AUTHENTICATED call into a 500 the moment anything registered a
      // telemetry listener, which the devtools console does four times
      // (`FJS-673`). Anonymous callers hold the root client and were fine, so
      // 1733 green tests never crossed the two. `installQueryTelemetry` taps
      // the root once and reads the call in scope for attribution.
      ctx.locals[SCOPED_KEY] = scopedDb
    }

    const scopedDb = ctx.locals[SCOPED_KEY] as LitestoneClient

    // Resolve the accessor against the client, literal spelling first.
    // `model` omitted → fall back to the service name, which the autoloader
    // derived from the filename ('posts.service.ts' → 'posts' → db.post).
    const candidates = accessorCandidates(model ?? ctx.service)
    for (const candidate of candidates) {
      // Probing must not assume a miss is quiet. A real Litestone client is a
      // Proxy that THROWS on an unknown accessor ('"posts" is not a table in
      // this schema') rather than returning undefined, so reading the plural
      // candidate first would abort before the singular one was ever tried —
      // the resolution order would work against plain objects and fail against
      // every real client. Catch and continue to the next spelling.
      let table: LitestoneTable | undefined
      try {
        table = scopedDb[candidate] as LitestoneTable | undefined
      } catch {
        continue
      }
      if (table) return table
    }

    // Name every spelling tried and everything on offer — the old message
    // repeated the name the caller already wrote and named no alternative,
    // which is the least useful moment to be terse.
    //
    // The try/catch is still here, but no longer for Litestone: its client used
    // to be a Proxy whose ownKeys trap returned `$setAuth` and `$db` twice, so
    // Object.keys() threw about proxy internals and buried this diagnostic
    // (`FJS-014`, fixed 2026-08-06 — all five traps dedupe now, pinned by tests).
    // What remains is that `db` is whatever the app handed to createApp, and a
    // stand-in that refuses to enumerate must not turn "your model name is
    // wrong" into a stack trace.
    let available: string[] = []
    try {
      // Prefer the schema: it says which accessors are MODELS. Enumerating the
      // client and dropping `$` names was the old approach and it could not tell
      // `post` from `sql`, `query` or `asSystem` — a list that offers `asSystem`
      // as a model name is worse than no list. It never showed, because the
      // enumeration threw before anyone read it.
      const models = (scopedDb as { $schema?: { models?: { name: string }[] } })?.$schema?.models
      const declared = Array.isArray(models)
        ? new Set(models.map(m => m.name.charAt(0).toLowerCase() + m.name.slice(1)))
        : null
      available = Object.keys(scopedDb)
        .filter(k => !k.startsWith('$') && k !== 'constructor')
        // Keep a key only if it IS a declared model. Invariant 2 fixes the
        // accessor as the model name with a lowercase first letter, so this is
        // an exact test rather than a guess about which names look like tables.
        .filter(k => declared === null || declared.has(k))
        .sort()
    } catch { /* client won't enumerate — the rest of the message still helps */ }

    throw new Error(
      `Litestone model '${candidates.join("' / '")}' not found on db client` +
      (model ? '' : ` (derived from service '${ctx.service}')`) +
      (available.length ? `. Available: ${available.join(', ')}` : '') +
      `. Model names are PascalCase singular, so 'model Post' is reached as 'post'.`
    )
  }

  async function restoreImpl(ctx: ServiceContext): Promise<unknown> {
    const table = getTable(ctx)
    const q     = parseQuery(ctx.query, paginate.default, paginate.max, ctx.directives)

    if (ctx.id) {
      const where = { [idField]: ctx.id }
      return table.restore({ where })
    }

    ensureBulkAllowed('restore')
    // `restore` already takes a multi-row where and answers the rows, so this
    // needs no per-row loop — and unlike patch/remove there is nothing for the
    // loop to enforce. It called restoreMany, which a Litestone table does not
    // have: every filtered restore was a 500 naming the missing function, on
    // every service, since the method was written.
    return table.restore({ where: q.where })
  }

  function softDeleteFilter(): Record<string, unknown> {
    return softDelete ? { [softDelete]: null } : {}
  }

  /**
   * The same filter, and the one directive that lifts it on a WRITE.
   *
   * Every read passes `$withDeleted` through and no write did, so the escape
   * hatch a `SoftDeletedUniqueError` points AT was unreachable through a
   * service (`FJS-523`). That 409 says a caller's value is held by a row they
   * cannot see, and litestone's documented way out is to move the value aside —
   * `update({ …, withDeleted: true })` — which is this.
   */
  function writeWhere(q: { withDeleted?: boolean }): Record<string, unknown> {
    return q.withDeleted ? {} : softDeleteFilter()
  }

  /**
   * The `@system` columns a hook on this call said the APPLICATION is supplying.
   *
   * `ctx.system.add('slots')` in a hook; `system: [...]` on the litestone call,
   * which keeps the gate, the row policies, soft-delete and the audit actor
   * where `asSystem()` drops all four (`FJS-644`). Absent on a call that named
   * none, so nothing reaches the boundary that did not have to.
   *
   * One reader per write ARG — five of them, enumerated because the argument
   * objects are built differently. What is not enumerated is the rule.
   */
  function systemFields(ctx: ServiceContext): string[] | undefined {
    return ctx.system?.size ? [...ctx.system] : undefined
  }

  /**
   * `remove` is the one write the directive does NOT lift, and it says so.
   *
   * Against an already-deleted row the only action left is to stop keeping it,
   * which is a hard delete — the one write that defeats `@@softDelete`. A
   * directive on the ordinary DELETE would hand that to every caller who may
   * remove a row, with no separate permission to grade and no way back, so
   * what a model declares recoverable would be recoverable until somebody put
   * six characters on a URL.
   *
   * It refused already; it refused by 404ing about a row that is plainly
   * there, which reads as the row being gone rather than as the directive
   * being declined. The refusal names the flag and the way out instead.
   *
   * Graded on the REQUEST and never on the row's state: the same call must not
   * succeed or refuse depending on whether the row happens to be deleted.
   */
  function refuseHardDelete(ctx: ServiceContext, q: { withDeleted?: boolean }): void {
    if (!q.withDeleted) return
    if (!softDelete && !modelSoftDeletes(ctx.locals.db, model ?? ctx.service)) return
    throw new BadRequest(
      `$withDeleted is not honored on remove. Removing a row on a soft-deleting model ` +
      `stamps it; destroying one is not something a directive turns on. To free a @unique ` +
      `value a deleted row still holds, move the value aside with PATCH ?$withDeleted=true.`
    )
  }

  function ensureBulkAllowed(op: string): void {
    if (!allowBulk) {
      throw new BadRequest(
        `Bulk ${op} is disabled on this service (set allowBulk: true to enable)`
      )
    }
  }

  /**
   * A filtered write with nothing in the filter is the whole table.
   *
   * `DELETE /orders` and `PATCH /orders` are one query parameter away from
   * their scoped forms, and a filter that arrives empty — a client that built
   * its query string from a variable, a form that submitted nothing — is
   * indistinguishable from one nobody wrote. Litestone reads the empty `where`
   * as *every row, deliberately*, which is the right answer for `truncate` and
   * the wrong one for a request.
   *
   * Asked of `q.where` BEFORE `softDeleteFilter()` is merged in, or the
   * framework's own clause counts as the caller's filter and the guard never
   * fires on a `@@softDelete` model.
   *
   * `restore` is deliberately outside this: it un-deletes, the way back is to
   * remove again, and strictness follows what a mistake destroys.
   */
  function ensureFiltered(op: string, where: Record<string, unknown>): void {
    if (Object.keys(where).length > 0) return
    throw new BadRequest(
      `Bulk ${op} with no filter conditions is not allowed — an empty filter is every row ` +
      `in the table. Provide at least one query parameter to scope it` +
      (op === 'patch' ? `, or patch one row by id.` : `, or delete one row by id.`)
    )
  }

  // ─── Filtered bulk writes ─────────────────────────────────────────────────
  //
  // A bulk patch or remove selects its rows and then writes them ONE AT A TIME,
  // for the same reason bulk create does: partial success needs a per-row
  // outcome, and `updateMany`/`removeMany` answer `{ count }`.
  //
  // The rest of the reason is enforcement. Litestone does not run `@@transitions`
  // on `updateMany` — deliberately, as a power tool whose caller "takes
  // responsibility", and its own note says to loop `update()` where transition
  // safety matters. Junction is that caller and had not: `PATCH /orders/1` was
  // refused by the state machine and `PATCH /orders?status=draft` was not, for
  // the identical move (`FJS-044`). `@version` went the same way — bumped on a
  // bulk write, never required — so optimistic concurrency was off for exactly
  // the writes that touch the most rows. Both are properties of `update()`, so
  // both come back by calling it.
  //
  // Two consequences worth stating rather than discovering:
  //
  //   • **No atomicity.** Same trade as bulk create — a failure leaves earlier
  //     rows written. `transactional:` on the service is how a caller gets
  //     all-or-nothing back, at the cost of partial success.
  //   • **Only rows the caller can READ are touched.** Selecting the targets
  //     applies the read policy; the write then applies the update/delete one.
  //     A row updatable but unreadable was reached by `updateMany` and is not
  //     reached now.
  async function bulkByRow(
    ctx:   ServiceContext,
    op:    'patch' | 'remove',
    table: LitestoneTable,
    where: Record<string, unknown>,
    apply: (id: unknown, version: Record<string, unknown>) => Promise<unknown>
  ): Promise<unknown> {
    const matched = await table.count({ where })
    if (matched > bulkMax) {
      throw new BadRequest(
        `Bulk ${op} matched ${matched} rows, above this service's limit of ${bulkMax}. ` +
        `A filtered bulk write runs one statement per row, so the limit is what stops one ` +
        `request holding the write lock for the length of the table. Narrow the filter, ` +
        `or raise bulkMax on the service.`
      )
    }

    const versionField = await modelVersionField(ctx.locals.db, model ?? ctx.service)

    const select: Record<string, unknown> = { [idField]: true }
    if (versionField) select[versionField] = true

    const targets = await table.findMany({ where, select }) as Record<string, unknown>[]

    // Not seeded from ctx.locals[BULK_FAILURES]: a filtered write carries ONE
    // payload, so validation validates it once and throws rather than parking
    // anything. Only bulk create has rows to partition.
    const data:   unknown[]     = []
    const errors: BulkFailure[] = []

    for (const target of targets) {
      const id = target[idField]
      try {
        // The version travels from the row just selected, which is what makes
        // this a read-modify-write rather than a blind one: a row that moved
        // between the select and the update is a VersionConflictError in
        // `errors`, not a silent overwrite.
        const row = await apply(id, versionField ? { [versionField]: target[versionField] } : {})
        if (row) data.push(row)
      } catch (err) {
        errors.push(toBulkFailure({ [idField]: id }, err))
      }
    }

    // Shape recognized by wrapResult → a list envelope carrying errors.
    return { data, total: data.length, errors }
  }

  return {
    async find(ctx: ServiceContext): Promise<unknown> {
      const table = getTable(ctx)
      const q     = parseQuery(ctx.query, paginate.default, paginate.max, ctx.directives)
      const where = { ...q.where, ...softDeleteFilter() }

      // FTS5 search path — routes to table.search() when $search is present.
      // Only works on models with @@fts; below that a Litestone client refuses
      // by name with a 400 (CapabilityNotDeclaredError), naming the attribute.
      //
      // `search()` answers the ROWS, ranked — it has no count to give, and this
      // destructured `{ rows, total }` off the array, so a search that matched
      // answered `{"limit":20,"offset":0}`: no data, no total, 200. The same
      // shape as the `restoreMany` that never existed (FJS-245) — a declared
      // method type nothing executes. The envelope owes a total, so the count
      // is a second, id-only pass, skipped when the first page is short enough
      // to BE the total.
      if (q.search) {
        const args: Record<string, unknown> = {
          where,
          limit:  q.limit,
          offset: q.offset,
        }
        if (q.orderBy)       args.orderBy       = q.orderBy
        if (q.select)        args.select        = q.select
        if (q.include)       args.include       = q.include
        if (q.withDeleted)   args.withDeleted   = true
        if (q.onlyDeleted)   args.onlyDeleted   = true
        if (q.withTemplates) args.withTemplates = true
        if (q.onlyTemplates) args.onlyTemplates = true

        const rows  = await table.search(q.search, args)
        const total = (!q.offset && rows.length < q.limit)
          ? rows.length
          : (await table.search(q.search, {
              ...args, limit: null, offset: 0, include: undefined,
              select: { [idField]: true },
            })).length

        return { total, limit: q.limit, offset: q.offset, data: rows }
      }

      const args: Record<string, unknown> = {
        where,
        limit:  q.limit,
        offset: q.offset,
      }
      if (q.orderBy)     args.orderBy     = q.orderBy
      if (q.select)      args.select      = q.select
      if (q.include)     args.include     = q.include
      if (q.withDeleted)   args.withDeleted   = true
      if (q.onlyDeleted)   args.onlyDeleted   = true
      if (q.withTemplates) args.withTemplates = true
      if (q.onlyTemplates) args.onlyTemplates = true

      // The window (`FJS-D145`) — a caller asking `$after` is growing a
      // window rather than stepping to a page. Both paths are `findWindow`'s,
      // because a service that assembles its own query answers the same two.
      return await findWindow(table, args, q.after, modelLabel(ctx))
    },

    async get(ctx: ServiceContext): Promise<unknown> {
      const table = getTable(ctx)
      const q     = parseQuery(ctx.query, 1, 1, ctx.directives)

      if (ctx.id) {
        // A URL segment is ONE value and this model's key is several.
        //
        // The list works — litestone orders and pages a tuple-keyed model
        // correctly as of `FJS-694` — but naming one row does not, and the
        // failure it used to give was the Data boundary's: *Unknown field 'id'
        // in where*, which reads as the schema being wrong rather than as the
        // request being unanswerable. Refused here, by name, with the two ways
        // out, because what a composite key should look like in a URL is a
        // decision about a public shape and not something to invent inside a
        // 404 path.
        const key = primaryKeyOf(ctx)
        if (key.length > 1 && !key.includes(idField)) throw new BadRequest(
          `${modelLabel(ctx)} is keyed by (${key.join(', ')}), so one value cannot name a row. ` +
          `Filter for it instead — GET /${ctx.service}?${key.map(k => `${k}=…`).join('&')} — ` +
          `or give the service a custom method that takes the whole key.`)

        const where = { [idField]: ctx.id, ...softDeleteFilter() }
        const args: Record<string, unknown> = { where }
        if (q.select)      args.select      = q.select
        if (q.include)     args.include     = q.include
        if (q.withDeleted)   args.withDeleted   = true
        if (q.onlyDeleted)   args.onlyDeleted   = true
        if (q.withTemplates) args.withTemplates = true
        if (q.onlyTemplates) args.onlyTemplates = true

        const record = await table.findUnique(args)
        if (!record) throw new NotFound(`${modelLabel(ctx)} with ${idField}=${ctx.id} not found`)
        return record
      }

      const { $limit, $offset, ...where } = ctx.query as Record<string, unknown>
      const args: Record<string, unknown> = {
        where: { ...parseWhere(where), ...softDeleteFilter() },
      }
      if (q.select)      args.select       = q.select
      if (q.include)     args.include      = q.include
      if (q.withDeleted)   args.withDeleted   = true
      if (q.onlyDeleted)   args.onlyDeleted   = true
      if (q.withTemplates) args.withTemplates = true
      if (q.onlyTemplates) args.onlyTemplates = true

      const record = await table.findFirst(args)
      if (!record) throw new NotFound(`${modelLabel(ctx)} not found`)
      return record
    },

    async create(ctx: ServiceContext): Promise<unknown> {
      if (!ctx.data) throw new BadRequest('Request body is required')

      // Policy first, database second. This guard used to run after
      // getTable(), so a misconfigured db turned "bulk writes are disabled on
      // this service" — a 400 the caller can act on — into a 500 about a
      // missing client. Whether bulk is permitted has nothing to do with
      // whether a connection resolves.
      if (Array.isArray(ctx.data)) ensureBulkAllowed('create')

      const table = getTable(ctx)
      const q     = parseQuery(ctx.query, 1, 1, ctx.directives)

      if (Array.isArray(ctx.data)) {

        // Partial success: rows are created individually so ONE bad row does
        // not reject the other forty-nine. Successes land in `data`, failures
        // in `errors` as { data, error } pairs — the input that failed, paired
        // with why, so a caller can tell which row was rejected.
        //
        // Two deliberate trade-offs against table.createMany():
        //   • N statements instead of one, and no all-or-nothing rollback.
        //     That IS the feature — atomicity and partial success are
        //     mutually exclusive. Callers who want all-or-nothing should wrap
        //     the call in a transaction.
        //   • It fixes a documented wart in passing: createMany returns
        //     { count } and no records, so bulk create could never echo
        //     stamped fields (ids, defaults, @slug). Now it can.
        const sys = systemFields(ctx)
        const created:  unknown[] = []
        // Seeded with anything the validation hooks already rejected, so a
        // response reports EVERY failed row, not just the ones that reached
        // the database.
        const failures: BulkFailure[] =
          (ctx.locals[BULK_FAILURES] as BulkFailure[] | undefined) ?? []

        for (const row of ctx.data) {
          try {
            created.push(await table.create({
              data: row as Record<string, unknown>,
              ...(sys ? { system: sys } : {}),
            }))
          } catch (err) {
            failures.push(toBulkFailure(row, err))
          }
        }

        // Shape recognized by wrapResult → a list envelope carrying errors.
        return { data: created, total: created.length, errors: failures }
      }

      const args: Record<string, unknown> = { data: ctx.data }
      if (q.select)  args.select  = q.select
      if (q.include) args.include = q.include
      const sysCreate = systemFields(ctx)
      if (sysCreate) args.system = sysCreate

      return table.create(args)
    },

    // update() — patch with an id REQUIRED, and no bulk path (`FJS-D179`).
    //
    // Not Feathers' full replace. The write is litestone's `table.update`, which
    // merges: a PUT stating only `title` leaves every column it did not name
    // where it was. What the id buys is that a REST client's PUT can never
    // become a bulk write, which patch's query path legitimately is.
    async update(ctx: ServiceContext): Promise<unknown> {
      if (!ctx.data) throw new BadRequest('Request body is required')
      if (!ctx.id)   throw new BadRequest('update() requires an id — use patch() for query-based writes')

      const table = getTable(ctx)
      const q     = parseQuery(ctx.query, paginate.default, paginate.max, ctx.directives)

      if (softDelete && (ctx.data as Record<string, unknown>)[softDelete] !== undefined) {
        throw new BadRequest(`Cannot set ${softDelete} directly — use remove()`)
      }

      const where = { [idField]: ctx.id, ...writeWhere(q) }

      // Single round trip: litestone's update() returns null when no row
      // matches — no need for a findUnique existence probe first (which
      // doubled the query count and was a TOCTOU race).
      const args: Record<string, unknown> = { where, data: ctx.data }
      if (q.select)      args.select      = q.select
      if (q.include)     args.include     = q.include
      if (q.withDeleted) args.withDeleted = true
      const sys = systemFields(ctx)
      if (sys) args.system = sys
      const updated = await table.update(args)
      if (!updated) throw new NotFound(`${modelLabel(ctx)} with ${idField}=${ctx.id} not found`)
      return updated
    },

    async patch(ctx: ServiceContext): Promise<unknown> {
      if (!ctx.data) throw new BadRequest('Request body is required')

      const table = getTable(ctx)
      const q     = parseQuery(ctx.query, paginate.default, paginate.max, ctx.directives)

      if (softDelete && (ctx.data as Record<string, unknown>)[softDelete] !== undefined) {
        throw new BadRequest(`Cannot set ${softDelete} directly — use remove()`)
      }

      if (ctx.id) {
        const where = { [idField]: ctx.id, ...writeWhere(q) }

        // Single round trip — update() returns null when no row matches.
        const args: Record<string, unknown> = { where, data: ctx.data }
        if (q.select)      args.select      = q.select
        if (q.include)     args.include     = q.include
        if (q.withDeleted) args.withDeleted = true
        const sys = systemFields(ctx)
        if (sys) args.system = sys
        const updated = await table.update(args)
        if (!updated) throw new NotFound(`${modelLabel(ctx)} with ${idField}=${ctx.id} not found`)
        return updated
      }

      ensureBulkAllowed('patch')

      const versionField = await modelVersionField(ctx.locals.db, model ?? ctx.service)
      if (versionField && versionField in (ctx.data as Record<string, unknown>)) {
        // One supplied version cannot be right for N rows: it would conflict on
        // every row but the one it was read from. bulkByRow reads each row's own.
        throw new BadRequest(
          `A bulk patch cannot carry ${versionField} — @version is per row, and one value ` +
          `would conflict on every row but one. Patch by id to use it, or drop it and let ` +
          `each row's own version be read.`
        )
      }

      // BY ID only, above. A bulk patch keeps the ordinary filter: `bulkByRow`
      // counts and selects its targets through `table.count`/`findMany`, which
      // apply litestone's own soft-delete filter, so widening the WHERE here
      // alone would match nothing and read as the directive being ignored.
      ensureFiltered('patch', q.where)

      const where = { ...q.where, ...softDeleteFilter() }
      const sysPatch = systemFields(ctx)
      return bulkByRow(ctx, 'patch', table, where, (id, version) =>
        table.update({
          where: { [idField]: id },
          data:  { ...(ctx.data as Record<string, unknown>), ...version },
          ...(sysPatch ? { system: sysPatch } : {}),
        })
      )
    },

    async remove(ctx: ServiceContext): Promise<unknown> {
      const table = getTable(ctx)
      const q     = parseQuery(ctx.query, paginate.default, paginate.max, ctx.directives)

      refuseHardDelete(ctx, q)

      if (ctx.id) {
        const where = { [idField]: ctx.id, ...softDeleteFilter() }

        // Single round trip — update()/remove() return null when no row
        // matches, so the findUnique existence probe was pure overhead.
        if (softDelete) {
          const stamped = await table.update({
            where,
            data: { [softDelete]: new Date().toISOString() },
          })
          if (!stamped) throw new NotFound(`${modelLabel(ctx)} with ${idField}=${ctx.id} not found`)
          return stamped
        }

        const removed = await table.remove({ where })
        if (!removed) throw new NotFound(`${modelLabel(ctx)} with ${idField}=${ctx.id} not found`)
        return removed
      }

      ensureBulkAllowed('remove')

      ensureFiltered('remove', q.where)

      const where = { ...q.where, ...softDeleteFilter() }

      if (softDelete) {
        // One stamp for the whole call, so a bulk soft-delete is one moment in
        // the data rather than a spread of them.
        const stamp = new Date().toISOString()
        return bulkByRow(ctx, 'remove', table, where, (id, version) =>
          table.update({
            where: { [idField]: id },
            data:  { [softDelete]: stamp, ...version },
          })
        )
      }

      return bulkByRow(ctx, 'remove', table, where, (id) =>
        table.remove({ where: { [idField]: id } })
      )
    },

    // restore() — complement to remove() for @@softDelete models.
    // Litestone's table.restore() unstamps the soft-delete column.
    // For Junction-side softDelete override models, this is a no-op
    // (those don't use Litestone's native restore).
    restore: restoreImpl,
  }
}

// ─── Automatic schema validation ────────────────────────────────────────────
//
// A Litestone client carries its own parsed schema on `$schema`, so a service
// backed by one already knows its field rules — @length, @email, @gte and the
// rest. Making every service restate that by passing
// `schema: generateJsonSchema(db.$schema)` is boilerplate that silently loses
// validation when forgotten, and it was forgotten by default:
// createBaseService had no schema option at all.
//
// This derives it instead. @frontierjs/litestone is a peer dependency, so the
// import is dynamic and its absence is tolerated — the same approach
// plugins/manifest already uses.

/**
 * Which document — litestone's property set is MODE-DEPENDENT, not just its
 * `required[]`. `create` omits `@id` and `@version`; `update` carries both.
 * Deriving one document and compiling every mode from it silently strips
 * whatever that mode was missing.
 */
type JsonSchemaMode = 'create' | 'update' | 'full'

// ─── What an adapter cache is keyed on ────────────────────────────────────
//
// Everything cached below is derived from the SCHEMA — the generated JSON
// Schema, the compiled validators, a model's column set, its `@version` column,
// its gate levels, whether it is row-scoped. None of it depends on who is
// asking.
//
// They were keyed on the CLIENT, and junction resolves a principal per request,
// so `$setAuth(user)` hands back a fresh proxy every time and every one of them
// missed on every call. Measured on the 188-model fixture: a create cost
// **7.38 ms** with a fresh principal and **0.49 ms** with one reused — 6.9 ms
// of rederivation per write, most of it `generateJsonSchema` (`FJS-777`).
//
// `$schema` is the parsed schema object and litestone shares it BY REFERENCE
// across every flavor — root, `$setAuth`, `asSystem`, `$scopedBy` all answer the
// same object — so it is the identity these caches always meant. Two clients
// over one schema share the entries, which is correct for exactly the same
// reason: what is cached is a fact about the schema.
//
// Falls back to the client itself where there is no `$schema` (a stand-in, a
// non-Litestone db), which is the behavior every one of these had before.
// Reading an unknown property off a Litestone client THROWS rather than
// answering undefined, so the probe is a throwing expression and is caught —
// the same trap `autoFilter` documents at its own `$checkWhere` probe.

// A non-object client cannot key a WeakMap at all, so it gets one shared entry
// rather than a crash. Nothing reaches here with one — every caller narrows
// first — and the alternative is a signature that lies about what it accepts.
const NO_CLIENT: object = Object.freeze({})

function schemaKey(client: unknown): object {
  if (!client || typeof client !== 'object') return NO_CLIENT
  let schema: unknown
  try { schema = (client as { $schema?: unknown }).$schema } catch { return client }
  return (schema && typeof schema === 'object') ? schema as object : client
}

const _jsonSchemaFor = new WeakMap<object, Map<JsonSchemaMode, Promise<LitestoneJsonSchema | null>>>()

let _warnedNoValidation = false
function _warnNoValidation(reason: string): void {
  if (_warnedNoValidation) return
  _warnedNoValidation = true
  console.warn(
    `[Junction] Schema validation is OFF. The database client carries a $schema, ` +
    `so field rules were expected to be derived from it — but @frontierjs/litestone ` +
    `could not be loaded: ${reason}. Services will accept unvalidated input. ` +
    `Install the peer dependency, or pass an explicit schema to createBaseService.`
  )
}

function _deriveJsonSchema(
  client: unknown,
  mode:   JsonSchemaMode = 'create',
): Promise<LitestoneJsonSchema | null> {
  const c = client as { $schema?: unknown } | null
  if (!c || typeof c !== 'object' || !c.$schema) return Promise.resolve(null)

  const key = schemaKey(c)
  let byMode = _jsonSchemaFor.get(key)
  if (!byMode) { byMode = new Map(); _jsonSchemaFor.set(key, byMode) }

  const cached = byMode.get(mode)
  if (cached) return cached

  const p = (async () => {
    try {
      // Asserted onto a one-property shape before, which is both a cast the
      // compiler refuses and a probe that could not fail: litestone really does
      // export this, so ask the real module and let the signature be checked.
      const mod = await import('@frontierjs/litestone')
      if (typeof mod.generateJsonSchema === 'function')
        return mod.generateJsonSchema(
          c.$schema as Parameters<typeof mod.generateJsonSchema>[0],
          { mode },
        ) as unknown as LitestoneJsonSchema
      _warnNoValidation('@frontierjs/litestone does not export generateJsonSchema')
      return null
    } catch (err) {
      // The client HAS a $schema, so it is a Litestone client and validation
      // was expected — swallowing this silently would drop field validation for
      // the whole app with no signal. Only reached when the peer dependency is
      // missing or broken.
      _warnNoValidation((err as Error)?.message ?? String(err))
      return null
    }
  })()

  byMode.set(mode, p)
  return p
}

/**
 * Map a Litestone ACCESSOR to its $defs key.
 *
 * generateJsonSchema keys $defs by model NAME ('Lead'), while services address
 * tables by accessor ('lead'). The old createLitestoneService used one value for both
 * lookups, so `{ name: 'leads', model: 'lead' }` matched neither and silently
 * skipped validation. Resolving through the schema's own model list fixes that
 * for every naming convention rather than guessing at plurals.
 */
export function resolveDefsKey(
  jsonSchema:   LitestoneJsonSchema,
  accessor:     string,
  parsedSchema?: unknown
): string | null {
  // Same normalization as _gateLevels — matching the literal accessor only
  // meant `model: 'posts'` resolved to no definition, and autoValidate read
  // that as "nothing to validate against" rather than as a misconfiguration.
  const candidates = accessorCandidates(accessor)
  const models = (parsedSchema as { models?: { name: string }[] } | null)?.models ?? []
  for (const candidate of candidates) {
    for (const m of models) {
      const acc = m.name.charAt(0).toLowerCase() + m.name.slice(1)
      if (acc === candidate) return m.name
    }
  }
  // Fall back to a direct hit, so an explicitly-keyed schema still works.
  for (const candidate of candidates) {
    if (jsonSchema.$defs[candidate]) return candidate
  }
  // …then the PascalCase form of the accessor. `$defs` is keyed by MODEL name
  // (`Lead`) while `model:` is the accessor (`lead`), so without this every
  // correctly-named model — PascalCase is mandatory — missed its own
  // definition and silently fell back to the db-derived schema. The models
  // loop above only covers the callers that pass `parsedSchema`; `createService`
  // does not.
  //
  // Guarded on `type: 'object'` because `$defs` is the whole definition table,
  // not a model list: an enum `Plan` sits beside model `Plan`, and resolving an
  // accessor to an enum is the same bug that made sierra's `createResource`
  // bind to one.
  for (const candidate of candidates) {
    const pascal = candidate.charAt(0).toUpperCase() + candidate.slice(1)
    const def    = jsonSchema.$defs[pascal] as { type?: string } | undefined
    if (def && def.type === 'object') return pascal
  }
  return null
}

/**
 * Every field name the model declares, read off the parsed schema.
 *
 * NOT the union of the generated documents: `createdAt` and `updatedAt` are in
 * no mode create/update/read emits, so a client echoing back a row it fetched
 * sends two keys the documents cannot vouch for. Derived from `$schema` so
 * nothing here restates what a model has.
 */
function modelFieldNames(schema: unknown, defsKey: string): Set<string> {
  const models = (schema as { models?: Array<{ name?: string, fields?: Array<{ name?: string }> }> })?.models
  const model  = Array.isArray(models) ? models.find(m => m?.name === defsKey) : null
  return new Set((model?.fields ?? []).map(f => f?.name).filter((n): n is string => typeof n === 'string'))
}

/**
 * The keys of `input` that name nothing the model declares.
 *
 * A dotted key is excluded here for `FJS-658`'s reason — `settings.commute`
 * names a field and the Data boundary answers it, in its own sentence.
 */
export function unknownKeys(input: unknown, fields: Set<string>): string[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return []
  return Object.keys(input as Record<string, unknown>).filter(k => {
    const dot = k.indexOf('.')
    return !fields.has(dot > 0 ? k.slice(0, dot) : k)
  })
}

/**
 * Refuse the keys of ONE row that name nothing the shape declares.
 *
 * Per row rather than over the whole payload, so a bulk write partitions the
 * way every other row error does — a wholesale throw would make partial success
 * unreachable for exactly the mistake most likely to appear in one row of a
 * hundred.
 *
 * There is no *did you mean*, and that is a refusal rather than an oversight:
 * litestone owns the typo hint (it is what `$checkWhere` carries back) and
 * exports neither of its two `editDistance` copies, so writing a third here
 * would be a new origin for the one thing this file must not invent. The
 * sentence names the key, the shape, and the way to accept it instead.
 */
export function checkUnknownKeys(
  ctx:    ServiceContext,
  row:    unknown,
  fields: Set<string>,
  what:   string,
  escape: string,
): void {
  // Fail OPEN on an empty set. A service over a view, an `@@external` model or
  // no model at all resolves to no fields, and refusing every key there would
  // turn a shape this cannot see into a shape nothing can call.
  if (!fields.size) return
  const bad = unknownKeys(row, fields)
  if (!bad.length) return

  throw fieldError(
    bad.map(field => ({
      field,
      message: `is not a field of ${what}. ${escape}`,
    })),
  )
}

const _compiledFor = new WeakMap<object, Map<string, {
  create:    import('./schema.ts').CompiledSchema
  patch:     import('./schema.ts').CompiledSchema
  /** The @transient fields this model declares — lifted off the payload after
   *  validation. Read off the generated schema at compile time, so a model with
   *  none pays one empty array for the life of the client. */
  transient: string[]
  /** Every field the MODEL declares, writable or not. The strip is right about
   *  a column a caller may not write — `id` on create, `createdAt`, a
   *  `@guarded` — and wrong about a word that is not a column at all, which can
   *  never come to mean anything. Only this set separates the two. */
  fields:    Set<string>
  /** The model's own name, for the sentence a refusal writes. */
  model:     string
} | null>>()

// Accessors already warned about, per client.
const _warnedUnvalidated = new WeakMap<object, Set<string>>()

/**
 * Does this accessor name a table on the client?
 *
 * A real Litestone client is a Proxy that THROWS on an unknown accessor, so
 * every candidate is probed inside a try — the same shape getTable uses.
 */
function _hasTable(client: Record<string, unknown>, accessor: string): boolean {
  for (const candidate of accessorCandidates(accessor)) {
    try {
      if (client[candidate]) return true
    } catch { /* not a table under this spelling — try the next */ }
  }
  return false
}

/**
 * A model-backed write reached no field rules. Say so, once.
 *
 * Silence here is the whole defect: a service whose $defs lookup misses accepts
 * unvalidated input and reports nothing, so a schema declaring @email, @length
 * and @gte enforces none of them and the first sign is bad data in the table.
 *
 * Only warned when the accessor DOES resolve to a table: a service with no
 * model at all is a supported shape (custom methods only, or its own create()),
 * and calling an unused CRUD method on one already fails with getTable's
 * diagnostic, which names every spelling tried.
 */
function _warnUnvalidated(
  client:   Record<string, unknown>,
  accessor: string,
  service:  string,
  reason:   string
): void {
  if (!_hasTable(client, accessor)) return

  const key = schemaKey(client)
  let seen = _warnedUnvalidated.get(key)
  if (!seen) { seen = new Set(); _warnedUnvalidated.set(key, seen) }
  if (seen.has(accessor)) return
  seen.add(accessor)

  console.warn(
    `[Junction] service '${service}': writes are NOT validated. The model '${accessor}' ` +
    `exists on the db client, but ${reason}, so @email/@length/@gte and every other ` +
    `field rule the schema declares are unenforced on create/update/patch. ` +
    `Model names are PascalCase singular, so 'model Post' is reached as 'post'.`
  )
}

// ─── Derived-hook marking ───────────────────────────────────────────────────
//
// The four hooks below are installed BY the framework, from the schema, and a
// service can pass through the merge twice: the autoloader spreads a built base
// back through createService, whose hooks map already carries this layer. The
// mark is what lets that second merge recognize its own work and skip it
// (`FJS-231`) — without it every autoloaded service graded its @@gate and ran
// its validator twice per request.
//
// A mark rather than the function's name: dedupe on name alone would let a USER
// hook that happens to be called `gateAuth` suppress the real one, which is
// fail-open on the thing that enforces access.

// A WeakSet rather than a property on the function: it adds nothing a spread,
// a serializer or an equality check can see, and membership follows the
// function itself — which is what survives being copied between hook maps.
const _derivedHooks = new WeakSet<Function>()

/** Tag a framework-derived hook. */
export function markDerived<T extends Function>(fn: T): T {
  _derivedHooks.add(fn)
  return fn
}

/** Was this hook installed by the framework rather than by an app? */
export function isDerivedHook(fn: unknown): boolean {
  return typeof fn === 'function' && _derivedHooks.has(fn)
}

/**
 * before-hook that validates ctx.data against the model's schema.
 *
 * Everything is resolved at call time: the client is not known when the service
 * module is imported, and neither is the schema.
 */
export function autoValidate(accessorOpt: string | undefined, mode: 'create' | 'patch') {
  // Named for the same reason as gateAuth — see the note there.
  return async function autoValidate(ctx: ServiceContext): Promise<void> {
    // accessor omitted → resolve from the service name, as getTable does.
    const accessor = accessorOpt ?? ctx.service
    const client = ctx.locals.db as { $schema?: unknown } | undefined
    if (!client) return

    // Two documents, because litestone's PROPERTY SET differs by mode and not
    // only its `required[]`. `@version` is emitted for update and omitted for
    // create, so a patch validator compiled off the create document strips the
    // version the caller sent — and the Data boundary then refuses the write
    // for not carrying one. `@version` was unusable through a service until
    // this asked for both.
    const [jsonSchema, updateSchemaDoc] = await Promise.all([
      _deriveJsonSchema(client, 'create'),
      _deriveJsonSchema(client, 'update'),
    ])
    if (!jsonSchema || !updateSchemaDoc) return

    const key = schemaKey(client)
    let perModel = _compiledFor.get(key)
    if (!perModel) { perModel = new Map(); _compiledFor.set(key, perModel) }

    if (!perModel.has(accessor)) {
      const defsKey = resolveDefsKey(jsonSchema, accessor, client.$schema)
      if (!defsKey) {
        perModel.set(accessor, null)
        _warnUnvalidated(
          client as Record<string, unknown>, accessor, ctx.service,
          `no definition in the generated schema matches ` +
          `'${accessorCandidates(accessor).join("' / '")}'`
        )
      } else {
        try {
          // jsonSchemaToJunctionSchema returns a spec; createSchema compiles it.
          perModel.set(accessor, {
            create:    createSchema(jsonSchemaToJunctionSchema(defsKey, jsonSchema,      'create')),
            patch:     createSchema(jsonSchemaToJunctionSchema(
                         defsKey, withVersionProperty(jsonSchema, updateSchemaDoc, defsKey), 'update')),
            transient: transientFields(jsonSchema, defsKey),
            fields:    modelFieldNames(client.$schema, defsKey),
            model:     defsKey,
          })
        } catch (err) {
          perModel.set(accessor, null)
          _warnUnvalidated(
            client as Record<string, unknown>, accessor, ctx.service,
            `its definition '${defsKey}' would not compile ` +
            `(${(err as Error)?.message ?? String(err)})`
          )
        }
      }
    }

    const compiled = perModel.get(accessor)
    if (!compiled) return

    if (!ctx.data) throw new BadRequest('Request body is required')

    const one = (row: unknown): Record<string, unknown> => {
      checkUnknownKeys(
        ctx, row, compiled.fields, compiled.model,
        'Declare it `@transient` on the model if a caller should be able to send it.',
      )
      return compiled[mode].parse(row) as Record<string, unknown>
    }

    // Bulk: validate element-wise and PARTITION. parse() rejects an array
    // outright ("Expected an object"), so this hook used to 400 every bulk
    // create before the service saw it; throwing on the first bad row would
    // make partial success unreachable. Rejected rows are parked for the
    // service to report in errors[].
    ctx.data = Array.isArray(ctx.data)
      ? partitionBulk(ctx, ctx.data, one)
      : one(ctx.data)

    liftTransient(ctx, compiled.transient)
  }
}

// ─── A custom method's declared input ─────────────────────────────────────
//
// `autoValidate` derives from a MODEL and covers create/patch on a model
// service. Everything else a service answers — `pay`, `ship`, `prune` — took
// `ctx.data` unvalidated, which is the largest unguarded surface junction had:
// the interesting operations in an app are exactly the ones that are not CRUD.
//
// The declaration is `methods: [{ method: 'pay', input: 'PayOrder' }]` and
// `PayOrder` is a `type T { … }` in the app's own seed, so nothing new decides
// what a shape is. It reaches `$defs` alongside the models, and the same
// `jsonSchemaToJunctionSchema` → `createSchema` pair compiles it.
//
// A named type that is not there THROWS rather than warning. A missing MODEL
// definition is a config that used to work, so autoValidate warns and carries
// on; an `input:` is a statement the author made this morning, and failing open
// on it hands back the assurance it was written to provide.

const _compiledInputs = new WeakMap<object, Map<string, import('./schema.ts').CompiledSchema | Error>>()

/** The `$defs` keys that describe an object — what an `input:` may name. */
function _objectDefNames(jsonSchema: LitestoneJsonSchema): string[] {
  return Object.entries(jsonSchema.$defs ?? {})
    .filter(([, def]) => (def as { type?: string })?.type === 'object')
    .map(([name]) => name)
    .sort()
}

/**
 * before-hook that validates ctx.data against a `type` declared in the seed.
 *
 * Resolved at call time for the same reason autoValidate is: the client — and
 * therefore the schema — is not known when the service module is imported.
 */
export function validateInput(defsKey: string, serviceName: string, method: string) {
  // Named for the same reason as gateAuth — see the note there.
  return async function validateInput(ctx: ServiceContext): Promise<void> {
    const client = ctx.locals.db as { $schema?: unknown } | undefined
    if (!client) return

    const jsonSchema = await _deriveJsonSchema(client, 'create')
    if (!jsonSchema) return

    const ck = schemaKey(client)
    let perKey = _compiledInputs.get(ck)
    if (!perKey) { perKey = new Map(); _compiledInputs.set(ck, perKey) }

    let compiled = perKey.get(defsKey)
    if (!compiled) {
      const def = jsonSchema.$defs?.[defsKey] as { type?: string } | undefined
      if (!def || def.type !== 'object') {
        compiled = new Error(
          `[Junction] service '${serviceName}': ${method} declares ` +
          `input: '${defsKey}', which is not an object type in the schema. ` +
          `Declare \`type ${defsKey} { … }\` in the seed. ` +
          `Available: ${_objectDefNames(jsonSchema).join(', ') || '(none)'}`
        )
      } else {
        try {
          compiled = createSchema(jsonSchemaToJunctionSchema(defsKey, jsonSchema, 'create'))
        } catch (err) {
          compiled = new Error(
            `[Junction] service '${serviceName}': ${method}'s input type ` +
            `'${defsKey}' would not compile (${(err as Error)?.message ?? String(err)})`
          )
        }
      }
      perKey.set(defsKey, compiled)
    }

    if (compiled instanceof Error) throw compiled
    const schema = compiled

    if (!ctx.data) throw new BadRequest('Request body is required')

    // A declared `type` has no unwritable half: every property IS the surface,
    // so the compiled schema's own key set is the field set.
    const declared = new Set(Object.keys(schema._schema))
    const one = (row: unknown): Record<string, unknown> => {
      checkUnknownKeys(
        ctx, row, declared, `type ${defsKey}`,
        `Add it to \`type ${defsKey}\` in the seed if this method should accept it.`,
      )
      return schema.parse(row) as Record<string, unknown>
    }

    // Element-wise for a bulk payload, exactly as autoValidate does — parse()
    // rejects an array outright, so a custom method taking a list would 400 on
    // every call.
    ctx.data = Array.isArray(ctx.data)
      ? partitionBulk(ctx, ctx.data, one)
      : one(ctx.data)
  }
}

/**
 * The create property set plus the `@version` column, and nothing else the
 * update document adds.
 *
 * `@version` is the one field a caller must be able to SEND that litestone
 * emits for update and not for create. The update document also carries `@id`,
 * which travels as `ctx.id` and must never reach `data`: litestone writes what
 * it is given, so `PATCH /docs/1 {"id":99}` would rewrite the primary key —
 * measured. Taking the whole update document would have opened exactly that.
 */
function withVersionProperty(
  createDoc: LitestoneJsonSchema,
  updateDoc: LitestoneJsonSchema,
  defsKey:   string,
): LitestoneJsonSchema {
  const cDef  = createDoc.$defs[defsKey] as LitestoneModelDef | undefined
  const uDef  = updateDoc.$defs[defsKey] as (LitestoneModelDef & { 'x-version'?: string }) | undefined
  const field = typeof uDef?.['x-version'] === 'string' ? uDef['x-version'] : null
  const prop  = field ? uDef?.properties?.[field] : null
  if (!cDef || !field || !prop) return createDoc

  return {
    ...createDoc,
    $defs: {
      ...createDoc.$defs,
      [defsKey]: { ...cDef, properties: { ...cDef.properties, [field]: prop } },
    },
  }
}

/** The @transient property names on a model's generated schema. */
function transientFields(jsonSchema: LitestoneJsonSchema, defsKey: string): string[] {
  const props = (jsonSchema.$defs?.[defsKey] as { properties?: Record<string, { 'x-litestone-kind'?: string }> })?.properties
  if (!props) return []
  return Object.entries(props)
    .filter(([, spec]) => spec?.['x-litestone-kind'] === 'transient')
    .map(([name]) => name)
}

/**
 * Move every @transient key from ctx.data to ctx.transients.
 *
 * It has to LEAVE the payload: the Data boundary refuses a transient key by
 * name — there is no column — so a service passing ctx.data on whole would fail
 * the write rather than the field. And it has to leave it AFTER validation, so
 * @length and @required are enforced on the value the caller actually sent.
 *
 * A BULK write carrying one is refused rather than lifted. The rows the service
 * receives are the ones that PASSED validation, so a per-row array of transient
 * values would be index-aligned with a list that has had rejects parked out of
 * it — a correlation bug that pairs one row's credential with another row. The
 * refusal is by name; nothing here is silent.
 */
function liftTransient(ctx: ServiceContext, fields: string[]): void {
  if (!fields.length || !ctx.data) return

  if (Array.isArray(ctx.data)) {
    const rows  = ctx.data as Record<string, unknown>[]
    const named = fields.filter(f => rows.some(row => row && typeof row === 'object' && f in row))
    if (named.length) throw new BadRequest(
      `A bulk write cannot carry ${named.map(f => `'${f}'`).join(', ')}: ` +
      `${named.length > 1 ? 'they are' : 'it is'} @transient, which is a value about ONE call — ` +
      `send the rows one at a time, or leave the field out`
    )
    return
  }

  const data = ctx.data as Record<string, unknown>
  // `??=` because a context built by hand — an app's own test helper — predates
  // this field, and a derived hook crashing on a shape it did not build is a
  // framework bug wearing an app's stack trace.
  const into = (ctx.transients ??= {})
  for (const f of fields) {
    if (!(f in data)) continue
    into[f] = data[f]
    delete data[f]
  }
}

// ─── An announcement is about a ROW ─────────────────────────────────────────
//
// A custom method may answer whatever it likes — but the same value is what
// gets announced, and a subscriber has nowhere to put anything that is not a
// row. The browser's store upserts BY ID and replaces wholesale, so:
//
//   { ok, server_id, status }   no id  → appended as a phantom row
//   { id, variables }           partial → replaces the row, losing the rest
//
// Both silent, in every open tab. Basecamp shipped four of them — `setVariable`,
// the deployment engine's five-field projection, the server heartbeat and
// `jobs.trigger` — and each was found by looking at a screenshot, because a
// page doing the obvious thing (`environment = await …setVariable(…)`) rendered
// "undefined" as its heading with every other assertion still passing. *A
// partial row is indistinguishable from a full one until it breaks* (`FJS-020`,
// ruled by `FJS-D08`).
//
// So the announcement carries the row: the payload when it already is one,
// otherwise the row re-read by id. When there is no id to re-read by, nothing
// is announced — a phantom row in every subscriber is worse than silence — and
// the service is told once, by name, with both ways out.
//
// Only model services are subject to this. A service with no model has no row
// for its answer to be a partial version of, so its payload travels untouched.

const _announceWarned = new Set<string>()

/** Test seam — the warning is once per service.method for the life of the process. */
export function resetAnnouncementWarnings(): void { _announceWarned.clear() }

const _columnsFor = new WeakMap<object, Map<string, Set<string> | null>>()

/** The columns the model declares, or null when the model cannot be resolved. */
async function modelColumns(client: unknown, accessor: string): Promise<Set<string> | null> {
  const c = client as { $schema?: unknown } | null
  if (!c || typeof c !== 'object') return null

  const key = schemaKey(c)
  let perModel = _columnsFor.get(key)
  if (!perModel) { perModel = new Map(); _columnsFor.set(key, perModel) }
  if (perModel.has(accessor)) return perModel.get(accessor)!

  const jsonSchema = await _deriveJsonSchema(client)
  const defsKey    = jsonSchema ? resolveDefsKey(jsonSchema, accessor, c.$schema) : null
  const def        = defsKey ? jsonSchema!.$defs[defsKey] as { properties?: Record<string, unknown> } : null
  const cols       = def?.properties ? new Set(Object.keys(def.properties)) : null

  perModel.set(accessor, cols)
  return cols
}

const _versionFor = new WeakMap<object, Map<string, string | null>>()

/**
 * The `@version` column this model declares, or null.
 *
 * `x-version` is the declared bridge for this and the browser client already
 * reads it — asking the generated schema rather than walking `$schema` keeps
 * one definition of *which column is the version*.
 */
async function modelVersionField(client: unknown, accessor: string): Promise<string | null> {
  const c = client as { $schema?: unknown } | null
  if (!c || typeof c !== 'object') return null

  const key = schemaKey(c)
  let perModel = _versionFor.get(key)
  if (!perModel) { perModel = new Map(); _versionFor.set(key, perModel) }
  if (perModel.has(accessor)) return perModel.get(accessor)!

  const jsonSchema = await _deriveJsonSchema(client)
  const defsKey    = jsonSchema ? resolveDefsKey(jsonSchema, accessor, c.$schema) : null
  const def        = defsKey ? jsonSchema!.$defs[defsKey] as { 'x-version'?: string } : null
  const field      = typeof def?.['x-version'] === 'string' ? def['x-version'] : null

  perModel.set(accessor, field)
  return field
}

/**
 * Does this model hide a removed row rather than destroying it?
 *
 * Asked of Litestone (`db.$softDelete`) rather than derived, for the reason
 * every other crossing here is asked: a second reading of `@@softDelete` is a
 * second answer, and the two drift.
 *
 * `in` rather than a bare read, and not only because a Litestone client throws
 * on an unknown property — a client older than the capability answers `false`,
 * which degrades to the behavior this refusal replaced instead of exploding.
 *
 * The map is keyed by MODEL name and a service names an accessor, so the
 * candidates are walked the way every other name crossing this boundary is.
 *
 * Not memoised, deliberately: `ctx.locals.db` is a fresh scoped client per
 * request, so a cache keyed on it would never hit — and the only caller runs
 * when a request actually carried the directive.
 */
function modelSoftDeletes(client: unknown, accessor: string): boolean {
  const c = client as { $softDelete?: Record<string, boolean> } | null
  if (!c || typeof c !== 'object' || !('$softDelete' in c)) return false

  const candidates = accessorCandidates(accessor)
  for (const [modelName, soft] of Object.entries(c.$softDelete ?? {})) {
    if (candidates.includes(modelName.charAt(0).toLowerCase() + modelName.slice(1)))
      return Boolean(soft)
  }
  return false
}

/** The accessor's table on this client, without tripping the throw-on-unknown proxy. */
function tableFor(client: unknown, accessor: string): { findFirst?: Function } | null {
  const c = client as Record<string, unknown> | null
  if (!c) return null
  for (const candidate of accessorCandidates(accessor)) {
    // `in` rather than a read: a Litestone client THROWS on an unknown property
    // rather than answering undefined, so probing by reading is an explosion.
    if (candidate in c) return c[candidate] as { findFirst?: Function }
  }
  return null
}

/**
 * What this call should announce — the row, or nothing.
 *
 * Returns the payload unchanged for anything this cannot judge (no model, no
 * client, an unresolvable accessor): *I cannot tell* is not *this is wrong*.
 */
export async function announcementPayload(
  ctx:      ServiceContext,
  payload:  unknown,
  accessor: string | undefined,
  idField:  string = 'id'
): Promise<unknown> {
  if (!accessor) return payload
  const client = ctx.locals?.db
  if (!client) return payload

  const columns = await modelColumns(client, accessor)
  if (!columns || columns.size === 0) return payload

  const keys    = payload && typeof payload === 'object' ? new Set(Object.keys(payload)) : new Set<string>()
  const missing = [...columns].filter(c => !keys.has(c))
  // Extra keys are fine — `{ ...job, queued: true }` is the whole row and a
  // flag, which is a row. Only an omission makes it a projection.
  if (missing.length === 0) return payload

  const id = (payload as Record<string, unknown> | null)?.[idField] ?? ctx.id
  const named = `${ctx.service}.${ctx.method}`
  const shown = missing.slice(0, 6).join(', ') + (missing.length > 6 ? `, +${missing.length - 6} more` : '')

  if (id != null) {
    try {
      const table = tableFor(client, accessor)
      const row   = await table?.findFirst?.({ where: { [idField]: id } })
      if (row) {
        warnOnce(named,
          `[Junction] ${named}() answered ${keys.size} of ${columns.size} columns — missing ${shown}. ` +
          `The announcement carries the row instead, re-read by ${idField}; the CALLER still gets the ` +
          `projection, and a page assigning it over the record it renders loses those fields. Answer the ` +
          `whole row, or state the payload with ctx.dispatch.`)
        return row
      }
    } catch {
      // A refused or failed re-read is not worth taking the call down for —
      // fall through to the suppression below, which says so.
    }
  }

  // No row to be found, so the payload travels as the SIGNAL it is. Dropping it
  // was the first design and it was wrong: a method that changes many rows
  // (`volumes.report` — added, updated, forgotten) has no single row to carry,
  // and its subscribers use the event as a trigger to re-read rather than as a
  // record. Suppressing would have stopped a live screen updating with nothing
  // but a server-side line to say why — the same silent failure this exists to
  // remove. The phantom-row half is closed on the client instead, where
  // `Store.upsert` refuses a record with no id.
  warnOnce(named,
    `[Junction] ${named}() announced something that is not a ${accessor} row — missing ${shown}` +
    `${id == null ? ', and carries no id to re-read one by' : ', and no row answered to that id'}. ` +
    `Subscribers can use it as a signal but cannot merge it into a record. Answer the row, or say what ` +
    `you mean with ctx.dispatch = <value> (which silences this), or ctx.dispatch = false to announce nothing.`)
  return payload
}

function warnOnce(key: string, message: string): void {
  if (_announceWarned.has(key)) return
  _announceWarned.add(key)
  console.warn(message)
}

// ─── Filter keys derived from the model ─────────────────────────────────────
//
// `GET /products?bogusColumn=7` answered `200 {"data":[],"total":0}`. So did a
// misplaced directive (`?limit=100`, where limit belongs on `$limit`), and so
// did a genuinely empty table. Three different situations, one answer, no error
// — it cost an hour in `example/`'s prerendered catalogue, which fetched,
// resolved, rendered "0 of 0 products" and reported nothing wrong (`FJS-109`).
//
// Litestone knew the whole time. It validates where-keys already, rejects them
// on writes, and on reads prints
//
//   [litestone] Unknown field 'bogusColumn' in where for Product.findManyAndCount.
//               Valid fields: id, name
//
// to the SERVER'S stderr — invisible to the caller who typed it. That split is
// right for the ORM (a typo'd filter on a write is a mis-scoped destructive
// operation; on a read it is merely empty) and wrong at a boundary that can
// answer 400.
//
// So this asks rather than re-deriving: `db.$checkWhere` keeps one definition of
// "is this a valid where key", including the typo hint and the AND/OR/NOT
// descent, and Junction contributes only the status code — the same division as
// gateAuth. A client without $checkWhere (a stand-in, a non-Litestone db)
// resolves to no problems and this no-ops.

interface WhereKeyProblem {
  key:         string
  suggestion:  string | null
  allowed:     string[]
  /** Where it sat — `customer.is.nope`. The bare key when it is top level. */
  path?:       string
  /** The model it was graded against, which is the TARGET through a relation. */
  model?:      string | null
  /** Why it was refused. `unknown` is a typo; anything else is a real field. */
  reason?:     string
  /** Litestone's own sentence, with `%MODEL%` still in it. */
  message?:    string
}

export function autoFilter(accessorOpt: string | undefined) {
  // Named for the same reason as gateAuth — see the note there.
  return function autoFilter(ctx: ServiceContext): void {
    const client = ctx.locals.db as {
      $checkWhere?: (a: string, w: unknown) => WhereKeyProblem[]
    } | undefined
    // Reading an unknown property off a Litestone client THROWS — the proxy
    // answers `"foo" is not a table in this schema` rather than `undefined`,
    // deliberately, so a typo'd accessor is loud. That makes the capability
    // probe itself a throwing expression, and it must be caught: when
    // `$checkWhere` was missing from the scoped proxies this line took down
    // every list read in both apps with a message about a table nobody named.
    let check: ((a: string, w: unknown) => WhereKeyProblem[]) | undefined
    try { check = client?.$checkWhere } catch { return }
    if (typeof check !== 'function') return
    if (!ctx.query || typeof ctx.query !== 'object') return

    // Resolved, never the literal — a service named for its URL is plural, and
    // an accessor the client does not know answers `[]`, which reads as "no
    // problems". See resolveAccessor.
    const accessor = resolveAccessor(client, accessorOpt ?? ctx.service)

    // parseWhere runs later and owns `$or`/`$and`/`$not`; the bridge has already
    // taken the `$` directives out (Invariant 10). What is left should be columns.
    const { $or: _o, $and: _a, $not: _n, ...plain } = ctx.query as Record<string, unknown>

    let problems: WhereKeyProblem[] = []
    try { problems = check.call(client, accessor, plain) ?? [] } catch { return }
    if (!problems.length) return

    // Name every bad key, not just the first — a caller fixing a filter one
    // round trip at a time is the thing the silent 200 already put them through.
    //
    // A key found through a RELATION reports its PATH and the model it was
    // graded against, because `allowed` is that model's column list: saying
    // *filterable fields on orders* while listing Customer's is a sentence that
    // sends the reader to the wrong schema (`FJS-776`).
    const where = (p: WhereKeyProblem) => p.path ?? p.key
    const named = (p: WhereKeyProblem) => p.message?.replace('%MODEL%', p.model ?? accessor) ?? ''

    // A key refused for a REASON is not an unknown key, and Litestone already
    // wrote the sentence. Saying *unknown filter key* about an `@encrypted`
    // column sends the caller to look for a typo in a name that is spelled
    // correctly — the reason is the whole answer, and this layer had been
    // throwing it away and re-deriving a worse one.
    const explained = problems.filter(p => p.reason && p.reason !== 'unknown')
    if (explained.length) {
      throw new BadRequest(
        explained.map(p => `${where(p)}: ${named(p)}`).join(' · '),
        explained.map(p => ({ field: where(p), message: named(p) })),
      )
    }

    const detail = problems.map(p =>
      `'${where(p)}'${p.suggestion ? ` — did you mean '${p.suggestion}'?` : ''}`).join(', ')
    const first = problems[0]
    const on    = first.model && first.model !== accessor ? first.model : accessor
    const valid = first.allowed.join(', ')
    throw new BadRequest(
      `Unknown filter ${problems.length > 1 ? 'keys' : 'key'} ${detail}. ` +
      `Filterable fields on ${on}: ${valid}. ` +
      `Paging and sorting are directives, not filters — use $limit, $offset, $orderBy, $select.`,
      problems.map(p => ({ field: where(p), message: `Unknown filter key '${where(p)}'` })),
    )
  }
}

// ─── Reserved query keys ────────────────────────────────────────────────────
//
// The third answer a service had no way to give. `$`-names are directives
// (Invariant 10) and everything else is graded against the model's columns, so
// a documented `?workspace_id=` fallback was refused by `autoFilter` with a 400
// naming it — before the app hook that reads it ever ran, and with no way for
// the app to fix it from its own side.
//
// A service declares `reservedQuery: ['workspace_id']` and the keys move to
// `ctx.reserved` in `callService`, BEFORE the pipeline: every hook then sees a
// query that is columns alone, whether it is one of ours or the app's, and a
// custom method is covered on the same terms as `find`. That is the query-side
// mirror of `liftTransient`, which does the same job for a payload key that is
// declared @transient and has no column.
//
// The difference is where the check can happen. A transient is declared IN THE
// SEED, so litestone knows it; a reservation is declared on the service, and
// the client is not known when a service module is imported. So a name that is
// also a column is caught on first use, once per service, and refused rather
// than resolved: a reservation that shadows a column silently stops that column
// filtering, which is the failure autoFilter exists to make loud.

const _reservedChecked = new Set<string>()

/** Test seam — a service rebuilt in one process must be re-checked. */
export function resetReservedQueryChecks(): void {
  _reservedChecked.clear()
}

export function liftReservedQuery(
  ctx: ServiceContext, service: string, keys: readonly string[] | undefined,
): void {
  if (!keys?.length) return

  const query = ctx.query as Record<string, unknown> | undefined
  const into  = (ctx.reserved ??= {})

  for (const k of keys) {
    if (!query || !(k in query)) continue
    into[k] = query[k]
    delete query[k]
  }

  if (_reservedChecked.has(service)) return
  _reservedChecked.add(service)

  // Reading an unknown property off a Litestone client THROWS, so the probe is
  // itself a throwing expression — see autoFilter.
  const client = ctx.locals.db as { $checkWhere?: (a: string, w: unknown) => WhereKeyProblem[] } | undefined
  let check: ((a: string, w: unknown) => WhereKeyProblem[]) | undefined
  try { check = client?.$checkWhere } catch { return }
  if (typeof check !== 'function') return

  const accessor = resolveAccessor(client, service)
  const probe    = Object.fromEntries(keys.map(k => [k, null]))
  let problems: WhereKeyProblem[] = []
  try { problems = check.call(client, accessor, probe) ?? [] } catch { return }

  // A key the model DID recognize is the collision: it came back with no
  // problem, so it is a real column and the reservation has taken it away.
  const bad = keys.filter(k => !problems.some(pr => pr.key === k))
  if (!bad.length) return

  throw new Error(
    `Service '${service}' reserves ${bad.map(k => `'${k}'`).join(', ')}, which ` +
    `${bad.length > 1 ? 'are columns' : 'is a column'} on ${accessor}. A reserved key is not a ` +
    `filter, so the reservation would stop that column filtering with nothing saying so. ` +
    `Rename the query key, or drop it from reservedQuery and let it filter.`)
}

// ─── Sort keys derived from the model ───────────────────────────────────────
//
// autoFilter's sibling, and the failure it closes is the quieter of the two.
// `GET /products?bogusColumn=7` at least answered an empty list; `?$orderBy=-
// bogusColumn` answered the RIGHT rows in the caller's original order and said
// nothing anywhere — no warning even on the server, because until litestone
// grew orderBy validation the key was simply quoted into SQL and resolved
// against the SELECT aliases, finding nothing. A caller cannot see a sort that
// did not happen, so page 2 of a "sorted" list is plausible and wrong.
//
// Same division as autoFilter: `db.$checkOrderBy` keeps the one definition of
// what is sortable — including the difference between a field that does not
// exist and a @computed field that cannot be sorted — and Junction contributes
// the status code. A client without $checkOrderBy no-ops.

interface OrderByKeyProblem {
  key: string
  reason: 'computed' | 'opaque' | 'unknown'
  suggestion: string | null
  sortable: string[]
  message: string
}

// Why a real, correctly spelled column is still not a sort key. Litestone owns
// the sentence (it is in `message`); this is the short form the summary line
// carries, so the two reasons a 400 has are not flattened into one.
const UNSORTABLE: Record<string, string> = {
  computed: ' (computed — not sortable)',
  opaque:   ' (stores a serialization — not sortable)',
}

export function autoSort(accessorOpt: string | undefined) {
  return function autoSort(ctx: ServiceContext): void {
    const client = ctx.locals.db as {
      $checkOrderBy?: (a: string, o: unknown) => OrderByKeyProblem[]
    } | undefined
    // Probing a Litestone client for a property it does not have THROWS — see
    // the note in autoFilter, and `FJS-117` for what that cost the last time.
    let check: ((a: string, o: unknown) => OrderByKeyProblem[]) | undefined
    try { check = client?.$checkOrderBy } catch { return }
    if (typeof check !== 'function') return

    const raw = ctx.directives?.orderBy
    if (raw == null) return

    // Same resolution as autoFilter, and it was broken here too — hidden only
    // because Litestone throws on a bad orderBy at execution where a bad where
    // merely warns. The hook exists to answer with a 400 that names the key.
    const accessor = resolveAccessor(client, accessorOpt ?? ctx.service)

    let problems: OrderByKeyProblem[] = []
    try { problems = check.call(client, accessor, parseSort(raw as SortParam)) ?? [] } catch { return }
    if (!problems.length) return

    const detail = problems.map(p =>
      `'${p.key}'${UNSORTABLE[p.reason] ?? ''}` +
      `${p.suggestion ? ` — did you mean '${p.suggestion}'?` : ''}`).join(', ')
    throw new BadRequest(
      `Unknown or unsortable $orderBy ${problems.length > 1 ? 'keys' : 'key'} ${detail}. ` +
      `Sortable fields on ${accessor}: ${problems[0].sortable.join(', ')}.`,
      problems.map(p => ({ field: p.key, message: p.message })),
    )
  }
}

// ─── Authentication derived from @@gate ─────────────────────────────────────
//
// A model's @@gate already states the minimum level per operation:
//
//   @@gate("4")        read/create/update/delete all require USER
//   @@gate("0.4")      read is public; writes require USER
//   @@gate("2.4.4.5")  read 2, create 4, update 4, delete 5
//
// Restating that as `before: { find: [authenticate], get: [authenticate], … }`
// on every service is five lines saying what one line already said — and the
// per-operation form cannot be expressed that way at all, so a public-read
// model had to either drop the hooks entirely or reject anonymous reads.
//
// Junction's contribution is the status code. The Gate plugin enforces the
// level at the data layer, but an anonymous request that gets that far fails as
// a policy error, not a 401. This rejects it at the API boundary instead.
//
// Only the anonymous case is derivable here: whether an AUTHENTICATED user
// clears level 4 depends on the app's own getLevel(), which Junction cannot
// see. That check stays where it belongs, in the data layer.

const GATE_OPS = { read: 'read', create: 'create', update: 'update', delete: 'delete' } as const
export type GateOp = keyof typeof GATE_OPS

const _gateFor = new WeakMap<object, Map<string, Record<GateOp, number> | null>>()

function _gateLevels(
  client:   unknown,
  accessor: string
): Record<GateOp, number> | null {
  const c = client as { $schema?: { models?: { name: string; attributes?: { kind: string; value?: unknown }[] }[] } } | null
  if (!c || typeof c !== 'object' || !c.$schema) return null

  const key = schemaKey(c)
  let perModel = _gateFor.get(key)
  if (!perModel) { perModel = new Map(); _gateFor.set(key, perModel) }
  if (perModel.has(accessor)) return perModel.get(accessor) ?? null

  // Match any accepted spelling of the accessor. Matching the literal string
  // only meant `model: 'posts'` found no model, returned null, and gateAuth
  // read that as "no @@gate declared" — i.e. unrestricted. A naming slip
  // silently disabled authentication.
  const candidates = accessorCandidates(accessor)
  const model = (c.$schema.models ?? []).find(
    (m) => candidates.includes(m.name.charAt(0).toLowerCase() + m.name.slice(1))
  )
  const raw = model?.attributes?.find((a) => a.kind === 'gate')?.value

  if (raw == null) { perModel.set(accessor, null); return null }

  // Same grammar as litestone's parseGateString: dot-separated, each level
  // defaulting to the previous one.
  const parts = String(raw).split('.').map(Number)
  if (parts.some(Number.isNaN)) { perModel.set(accessor, null); return null }
  const [r, cr, u, d] = parts
  const read   = r  ?? 0
  const create = cr ?? read
  const update = u  ?? create
  const del    = d  ?? update

  const levels = { read, create, update, delete: del }
  perModel.set(accessor, levels)
  return levels
}

/**
 * The model's declared READ gate, or null where it declares none.
 *
 * The coarse half of who may see a row, and the only half that can be answered
 * about a payload that carries no row: a bulk write announces a COUNT
 * (`FJS-D34`), so there is nothing for `$readAs` to grade and a broadcast of
 * *something you cannot read changed* is still an existence oracle over a gated
 * model. Graded here rather than at the Data boundary because litestone exposes
 * no gate-only entry point; it is the same `@@gate` reading `gateAuth` already
 * runs, against `sessionGateLevel`, which is the hand copy the Bridge index
 * names — change one and ask whether the other needs it.
 */
export function readGateLevel(client: unknown, accessor: string): number | null {
  return _gateLevels(client, accessor)?.read ?? null
}

/**
 * before-hook rejecting anonymous requests when the model's @@gate requires a
 * level above STRANGER for this operation.
 *
 * Resolved at call time — the client is not known when a service module is
 * imported. A non-Litestone client, or a model with no @@gate, is unrestricted
 * and this no-ops.
 */
export function gateAuth(accessor: string | undefined, op: GateOp) {
  // Named, not anonymous: these are framework-derived hooks, and the dev-mode
  // "anonymous hook" warning exists to nag about USER hooks. Every model
  // service installs six of these, so an unnamed one meant six warnings per
  // service on every boot — the framework complaining about itself — and six
  // entries reading 'anonymous' in the telemetry waterfall.
  return function gateAuth(ctx: ServiceContext): void {
    // accessor omitted → same fallback as getTable, so a model-less
    // createBaseService({}) is still gated by the model's @@gate.
    const levels = _gateLevels(ctx.locals.db, accessor ?? ctx.service)
    if (!levels) return
    if (levels[op] > 0 && !ctx.auth?.user) {
      throw new Unauthorized('Authentication required')
    }
  }
}

/**
 * The standing a CUSTOM method requires, and where its floor comes from.
 *
 * A method the CRUD map does not name used to be gated by nothing here, which
 * is not the same as being unguarded — a body that writes is still refused at
 * the Data boundary by the model's own `@@gate`. What it cost is that the
 * refusal arrived AFTER the body had run: measured, an anonymous `POST` with
 * `X-Service-Method: refund` against a `@@gate("5.5.5.5")` model executed the
 * handler, charged the card, and only then took a 403 from the first write —
 * where every CRUD verb on the same service answered 401 having run nothing
 * (`FJS-826`).
 *
 * The floor is DERIVED and it is the model's READ gate: to call anything on a
 * service you must at least be able to see the model, which is exactly what
 * `find` already requires. Nothing else about a custom method is derivable —
 * `availability` and `refund` sit on one service over one model — so above the
 * floor it is declared, `methods: [{ method: 'refund', gate: 5 }]`.
 *
 * Deliberately NOT the strictest of the write gates, which was the first shape
 * tried: measured against this repo's own apps it would have shut the public
 * storefront's `ProductVariant.availability` and every verb of the guest
 * basket, both of which sit on read-gate-0 models on purpose.
 */
function customGateFloor(levels: Record<GateOp, number>): number {
  return levels.read
}

/** Said once per method, never per request — a refusal an attacker can repeat. */
const _floorWarned = new Set<string>()

function warnFloorRefusal(service: string, method: string, need: number): void {
  const key = `${service}.${method}`
  if (_floorWarned.has(key)) return
  _floorWarned.add(key)
  console.warn(
    `[Junction] ${key}() refused a caller with no session: it is a custom method, ` +
    `so it takes the model's read gate (${need}) as its floor. If this method is ` +
    `authenticated by something other than a session — a signed machine-to-machine ` +
    `call, a webhook — say so: methods: [{ method: '${method}', gate: 0 }].`
  )
}

/**
 * The same refusal, as an AROUND hook — which is the position it has to hold.
 *
 * A before hook cannot lead the chain: `resolvePipelines` runs `before.all`
 * ahead of `before.<method>`, so a service declaring `before: { all: [...] }`
 * still had its own rule execute for a stranger no matter where the derived
 * layer was spliced into the per-method list (`FJS-403`). An around hook wraps
 * every before hook there is, and a SERVICE-level one sits inside the app-level
 * `withLitestoneDb` that scopes the client this reads — so the gate is graded
 * with a client in hand and before anything an app wrote, at either scope.
 *
 * One hook rather than six: the operation is a property of the method, and a
 * method the map does not name is not gated here — which is what a custom
 * method has always got.
 */
const OP_FOR_METHOD: Record<string, GateOp> = {
  find: 'read', get: 'read', create: 'create',
  patch: 'update', update: 'update', remove: 'delete',
}

export function gateAuthAround(
  accessor: string | undefined,
  /** Levels declared per method — `methods: [{ method, gate }]`. */
  declared: Record<string, number> = {},
) {
  // Aliased before the returned function shadows the name. Keeping the name is
  // not cosmetic: DERIVED_HOOKS, the telemetry waterfall and every committed
  // surface.snapshot.md read a hook by it.
  const make   = gateAuth
  const checks = new Map<GateOp, (ctx: ServiceContext) => void>()

  return async function gateAuth(ctx: ServiceContext, next: () => Promise<void>): Promise<void> {
    const method = ctx.method as string
    const op     = OP_FOR_METHOD[method]

    if (op) {
      let check = checks.get(op)
      if (!check) { check = make(accessor, op); checks.set(op, check) }
      check(ctx)
    } else {
      const levels = _gateLevels(ctx.locals.db, accessor ?? ctx.service)
      if (levels) {
        const need = declared[method] ?? customGateFloor(levels)
        if (need > 0) {
          // A stranger and a caller who is merely too junior are different
          // answers and a client acts on them differently — a 401 is what a
          // browser client responds to by discarding its token. Same split the
          // webhooks plugin makes.
          if (!ctx.auth?.user) {
            // The 401 body stays generic — it is written for a caller, and
            // naming the declaration in it would hand an attacker the shape of
            // the fix. The actionable sentence goes to the OPERATOR's log
            // instead, once per method, because the case it covers is real and
            // otherwise reads as an unexplained break: a method authenticated
            // by something that is NOT a session — a signed machine-to-machine
            // call, an outpost heartbeat — has no principal by design and takes
            // the floor for a reason that does not apply to it.
            warnFloorRefusal(ctx.service, method, need)
            throw new Unauthorized('Authentication required')
          }
          // The LEVEL is only graded where it was declared. The floor is a
          // presence check, exactly as `find` is: how far above `read` a caller
          // stands is the Data boundary's to answer, and re-deciding it here
          // would be a second reading of the model's own gate.
          if (declared[method] !== undefined && !levelPasses(need, sessionGateLevel(ctx.auth.user)))
            throw new Forbidden(
              `'${ctx.service}.${method}' requires level ${need}, ` +
              `caller has level ${sessionGateLevel(ctx.auth.user)}`)
        }
      }
    }
    await next()
  }
}

// ─── Session → gate level ─────────────────────────────────────────────────

/**
 * The access-level scale.
 *
 * It was a local copy, on the reasoning that `@frontierjs/litestone` is an
 * optional peer here and junction's resolution of it is a different build from
 * the one an app passes in. Both halves of that were true and the conclusion
 * was a fourth copy of a ladder that had already drifted (`FJS-D197`). The kit
 * answers it: `@frontierjs/toolbelt/gate` is substrate below the dependency
 * graph, so this is the one litestone reads and not a mirror of it, and nothing
 * about the peer resolution changed.
 */
export { LEVELS } from '@frontierjs/toolbelt/gate'

/**
 * Grade a Junction session on Litestone's 0–7 scale.
 *
 * Pass to Litestone's GatePlugin so @@gate can authorize a Junction caller:
 *
 *   import { GatePlugin }        from '@frontierjs/litestone'
 *   import { sessionGateLevel }  from '@frontierjs/junction'
 *
 *   const db = await createClient({
 *     db, schema,
 *     plugins: [new GatePlugin({ getLevel: sessionGateLevel })],
 *   })
 *
 * ─── Why this exists ──────────────────────────────────────────────────────
 *
 * It is `@frontierjs/toolbelt/gate`'s `gradeStanding` under the name Junction
 * has always exported, and Litestone's `FrontierGateGetLevel` is the same
 * binding from the other side. It was written here because Litestone owns the
 * scale and cannot be imported the other way, so each realm graded its own
 * session shape — which made it a HAND COPY carrying a comment on both sides
 * saying *change one, change both*.
 *
 * They drifted. 8 of the 216 combinations of the fields a session carries
 * graded CREATOR(3) in Litestone and USER(4) here, all of them a signed-in
 * caller with no `role`, so one `@@gate("4")` read was a 403 or a 200 depending
 * on which resolver the app had installed — and which one that was is not
 * obvious, since a schema declaring any `@@gate` auto-installs Litestone's
 * rather than this (`FJS-520`, ruled `FJS-D197`). The kit is substrate, below
 * the dependency graph, so both realms import one definition and neither
 * imports the other.
 *
 * ─── The rule ─────────────────────────────────────────────────────────────
 *
 * Absence is not an objection. A field left `undefined` means the app does not
 * model that stage, so it cannot hold anyone back; `null` means the app models
 * it and this user has not reached it. An app with no verification flow is not
 * an app whose users are all unverified.
 *
 *   no session                     → STRANGER      (0)
 *   verifiedAt: null               → VISITOR       (1)
 *   activatedAt: null              → READER        (2)
 *   isSystemAdmin                  → SYSADMIN      (7)
 *   isOwner                        → OWNER         (6)
 *   isAdmin                        → ADMINISTRATOR (5)
 *   signed in, no role             → CREATOR       (3)
 *   anything else that authenticated → USER        (4)
 *
 * Role strings are NOT interpreted. 'admin' means whatever an app decides it
 * means, and guessing would hand out level 5 on a string match — so the column
 * is read for PRESENCE and nothing else, and a caller the app has given no role
 * may submit but not manage. Apps that grade by role wrap this:
 *
 *   getLevel: (u) => u?.role === 'staff' ? LEVELS.ADMINISTRATOR : sessionGateLevel(u)
 */
/**
 * What `sessionGateLevel()` reads — the kit's type, re-exported rather than
 * declared a second time.
 *
 * Structural on purpose, and that reasoning now lives beside the function it
 * describes: typing the parameter as `SessionContext` would not compose,
 * because Litestone types GatePlugin's `getLevel` as
 * `(user: LitestoneAuth | null, model: string) => number` and a
 * SessionContext-only signature is not assignable to it. The kit's shape is a
 * supertype of both.
 */
export type { GradableUser } from '@frontierjs/toolbelt/gate'

export const sessionGateLevel: (user?: GradableUser | null) => number = gradeStanding

/**
 * A Junction session as Litestone's `auth()` sees it.
 *
 * **The one translation between two identity shapes.** Junction's
 * `SessionContext` names the caller `userId`; Litestone's policy language reads
 * `auth().id` — that is its documented spelling, used by `@default(auth().id)`
 * and by every `@@allow` example it ships. Handing a `SessionContext` straight
 * to `$setAuth` therefore gives the Data boundary a principal with **no `id`**,
 * and a row policy written the documented way:
 *
 *   @@allow('read', userId == auth().id)
 *
 * compares a column to `undefined` and matches nothing. No error, no warning —
 * an empty list. Every gate still worked, because `sessionGateLevel()` was
 * written against Junction's shape; policies read Litestone's, and nothing
 * bridged the two. Found 2026-08-06 in `example/`, where a user's own
 * notifications were invisible to them and visible to `asSystem()`.
 *
 * Everything else passes through by name — `role`, `accountId`, `workspaceId`,
 * `email` are already spelled the same on both sides — and an explicit `id`
 * wins, so a caller that already speaks Litestone's shape is untouched.
 *
 * Sibling of `sessionGateLevel()`: same boundary, same direction, one for the
 * ordinal gate and one for the policy predicate.
 */
export function toDataPrincipal(user: unknown): unknown {
  if (!user || typeof user !== 'object') return user
  const u = user as { id?: unknown; userId?: unknown }
  if (u.id !== undefined && u.id !== null) return user
  if (u.userId === undefined || u.userId === null) return user
  return { ...user, id: u.userId }
}

// ─── Claims resolved per request ─────────────────────────────────────────────
//
// A tenant claim and a per-request standing are the same thing: values put on
// the PRINCIPAL for this call, one read by a tenancy predicate and one by the
// gate (`FJS-D113`). Row tenancy reads its claim off the principal, and until
// this seam existed the only way one got there was `sessionFields` — fixed at
// sign-in, which is one tenant per session. A person who belongs to several
// accounts and holds a different authority in each could not be expressed.
//
// It lives INSIDE `withLitestoneDb` rather than beside it, and that is the
// point. Three things have to happen in one order, each of which an app got
// wrong at least once before this existed:
//
//   1. resolve the claims, which needs the request
//   2. build a FRESH principal and assign `ctx.auth.user` — not just the
//      client, because `getTable()` re-derives its own scoped copy from
//      `ctx.auth.user`, so a standing living only on `ctx.locals.db` is dropped
//      the moment a service touches a model
//   3. scope the client from that principal
//
// One hook means there is no order for an app to arrange, and nothing to
// compose in the wrong sequence.
//
// A fresh object is not a style choice: over WebSocket the session is resolved
// once at upgrade and the same object is handed to every frame, and the
// internal-call path freezes it. Mutating it either throws or leaks one call's
// tenant into the next call on that socket.

export type PrincipalClaims = Record<string, unknown>

/**
 * Resolve extra claims for this call. Hook tier (`FJS-D06`) — it may shape
 * what follows and may not refuse; refusal belongs to the guards.
 *
 * Runs only for an AUTHENTICATED caller. Anonymous is deliberately not its
 * business, on the same ground `tenantClaimGuard` states: nobody is not a
 * caller missing a claim, and minting a principal out of claims alone would
 * turn *anonymous* into *someone* — an object that satisfies `auth() != null`
 * while carrying no identity. A tenant for an anonymous caller is what
 * `strategy database` resolves by host.
 *
 * **The claim is the proof.** Under declared row tenancy, emitting the tenancy
 * claim without establishing that the caller belongs scopes them INTO that
 * tenant, and every read answers 200. Return `{}` when the caller has no
 * standing; `membershipClaim()` is the shipped resolver that cannot get this
 * wrong.
 */
export type PrincipalResolver = (
  ctx:  ServiceContext,
  user: ServiceContext['auth']['user'] | null,
) => PrincipalClaims | Promise<PrincipalClaims>

/**
 * Where the app parks its principal resolver, so a tool can read it back.
 *
 * A Symbol rather than a property: `app.principal()` is already a method (WHO is
 * in scope right now) and a resolver is a different noun wearing the same word.
 * Non-enumerable by construction, so a spread of the app does not carry it.
 */
export const PRINCIPAL_RESOLVER = Symbol.for('junction.principalResolver')

/** Where `createApp({ tenants })` parks the registry, for the same reason. Under
 *  that strategy there is no app-wide client to ask the declaration of. */
export const TENANT_REGISTRY = Symbol.for('junction.tenantRegistry')

/** Claims that would change WHO is calling rather than what they hold here. */
const IDENTITY_KEYS = ['userId', 'id'] as const

// Whether a resolver ran for this call, and why it produced nothing.
//
// Three refusals wear the same empty principal and they are three different
// answers. Nothing in the app emits this claim at all — a developer's problem,
// and the only one where no resolver has run. The request named no tenant — a
// 400, because the request is incomplete rather than refused. The request named
// one this caller does not belong to — a 403.
//
// The resolver is the only thing that can tell the last two apart, so it says
// so; a resolver that states nothing falls to the refusal, which is the safe
// half.
const RESOLVED = 'principal.resolved'
const NO_CLAIM = 'principal.noClaim'

/** Why a resolver produced no claim, and — where the request named no tenant —
 *  how one is named, which only the resolver knows. Set by the resolver, read
 *  by `tenantClaimGuard`. */
export interface NoClaim {
  reason:   'unnamed' | 'refused'
  namedBy?: string
}

/**
 * Merge claims onto the calling principal and re-scope the client from it.
 *
 * Exported because resolution is not always once per call: a service may
 * legitimately address a different tenant than the request named — the service
 * whose subject IS the tenant is the usual one — and re-resolving is what stops
 * a caller who is admin of A carrying that standing into a request against B.
 */
export function applyClaims(
  ctx:    ServiceContext,
  db:     unknown,
  claims: PrincipalClaims,
): void {
  const user = ctx.auth?.user

  // Refused by name rather than stripped in silence. A resolver answering
  // `{ userId: someoneElse }` is not a claim about what this caller holds, it
  // is a different caller — and a framework that quietly dropped the key would
  // leave an app believing it had switched identity.
  const identity = IDENTITY_KEYS.filter(k => k in claims)
  if (identity.length) throw new BadRequest(
    `A principal resolver may not set ${identity.map(k => `'${k}'`).join(' or ')} — ` +
    `claims say what this caller HOLDS for this request, not who they are. ` +
    `Use IAuth to establish identity.`,
  )

  ctx.locals[RESOLVED] = true

  const client = db as LitestoneClient

  liftRowTenant(ctx, client, claims)

  // ── A guest ───────────────────────────────────────────────────────────────
  //
  // A caller with no session may still hold a claim the REQUEST proves: a cart
  // token, an invitation token, an unsubscribe token. The claims reach the Data
  // boundary so `@@allow('read', token == auth().cartToken)` can scope rows to
  // the bearer, which is the only way a schema can own access for a population
  // that has no `auth().id`.
  //
  // **The claims must NOT become `ctx.auth.user`, and this is the whole of the
  // care this path needs.** `sessionGateLevel` grades any object it is handed:
  // a claims-only principal sets none of `isSystemAdmin`/`isOwner`/`isAdmin`
  // and leaves `verifiedAt`/`activatedAt` undefined — which is SILENCE, not
  // `null` — so it falls through to `LEVELS.USER`. Promoting a guest to a
  // session object would therefore grade every anonymous caller 4 in every app
  // that adopted a resolver, silently. `ctx.auth.user` stays null, the gate
  // still grades STRANGER(0), and the claim decides only WHICH ROWS.
  if (!user) {
    if (!Object.keys(claims).length) return
    if (typeof client?.$setAuth === 'function')
      ctx.locals.db = client.$setAuth({ ...claims })
    return
  }

  const principal = freezeUser({ ...user, ...claims })
  ctx.auth.user   = principal as typeof user

  if (typeof client?.$setAuth === 'function')
    ctx.locals.db = client.$setAuth(toDataPrincipal(principal))
}

/**
 * Resolve this tenant's configuration before anything downstream reads it.
 *
 * `$.config` is a property read and a resolver that reads a row is async, so the
 * two can only meet where the tenant is ALREADY known — which is here, in the
 * hook that just established it, exactly as `applyClaims` resolves the principal
 * here rather than at the point a policy needs it.
 *
 * A failure is NOT swallowed: a tenant whose configuration could not be resolved
 * would otherwise silently serve the floor, which for a from-address or a bucket
 * means one tenant's mail going out under another's name.
 */
async function warmTenantConfig(ctx: ServiceContext): Promise<void> {
  const app = (ctx as { app?: { loadTenantConfig?: (id: string) => Promise<unknown>; tenantConfig?: unknown } }).app
  if (!app?.tenantConfig) return
  const id = ctx.locals?.tenantId
  if (id == null) return
  await app.loadTenantConfig?.(String(id))
}

export function withLitestoneDb(db: unknown, principal?: PrincipalResolver): import('./hooks.ts').AroundHook {
  return async (ctx, next) => {
    // Scope to the caller here, not in the service.
    //
    // This used to seed the ROOT client and leave $setAuth to
    // one of two service factories. createBaseService never scoped at all, so a
    // service written with it ran unscoped — and a schema declaring
    // `@@allow('read', ownerId == auth().id)` then compared against a null
    // auth() and matched nothing. The service looked broken; the policy was
    // fine. Which factory you picked silently decided whether your row policies
    // worked.
    //
    // Doing it once here means both factories get a caller-scoped client, and
    // ctx.auth.user is already populated by the transport bridge before
    // callService() runs.
    const client = db as LitestoneClient
    ctx.locals.db =
      ctx.auth?.user && typeof client?.$setAuth === 'function'
        ? client.$setAuth(toDataPrincipal(ctx.auth.user))
        : client

    // Before the resolver, because most apps have no resolver: the claim came
    // from `sessionFields` at sign-in and is already on the principal.
    // `applyClaims` lifts it again afterwards, where a resolver moved it.
    liftRowTenant(ctx, db)

    // After the scope above and before `next()`: the resolver may read through
    // `ctx.locals.db`, and everything downstream must see the claims.
    //
    // Run for a GUEST as well as for a session. The resolver is the only thing
    // that can turn something the request carries — a cart token, an invitation
    // — into a claim a row policy can read, and the population that needs it
    // most is exactly the one with no `auth().id`. A resolver written before
    // this is now called with `null`, which is why `membershipClaim` refuses by
    // name rather than reading `userId` off nothing.
    if (principal)
      applyClaims(ctx, db, await principal(ctx, ctx.auth?.user ?? null))

    // After the claims, because under `strategy row` the tenant IS a claim and
    // is not known until they are merged.
    await warmTenantConfig(ctx)

    await next()
  }
}


// ─── membershipClaim ─────────────────────────────────────────────────────────
//
// The shipped resolver for the shape almost every B2B application has: a person
// belongs to several tenants through a membership row, picks one per request,
// and holds a standing that lives on that row.
//
// It is a BATTERY and not seed syntax, and the ruling says why (`FJS-D113`):
// `@@tenant(via:)` already means *scoped through this parent*, so a second
// spelling of `via` would be one word with two meanings inside one feature —
// and a declaration would hard-code that membership is one model with one
// subject column and one standing column, which is false for membership through
// a team, for a role that is a join, and for more than one role. An app whose
// membership does not fit writes the plain function and composes it; that is
// the escape hatch, and it is the same road rather than a worse one.
//
// What it buys over doing it by hand is the one line that matters: it cannot
// emit a claim it did not verify. Under declared row tenancy the version that
// forgets the membership check scopes a stranger INTO the tenant and every read
// answers 200 — no error, no empty list, nothing to notice.

export interface MembershipClaimOptions {
  /** Where the tenant comes from — a header, a param, a subdomain. Transport
   *  convention, so it is a function and never a declaration (Invariant 10). */
  tenantFrom: (ctx: ServiceContext) => string | null | undefined
  /** The membership accessor — `workspaceMember` for `model WorkspaceMember`. */
  model:      string
  /** The column holding the caller: matched against the principal's `userId`. */
  subject:    string
  /** The column holding the tenant. Also the CLAIM's name on the principal,
   *  unless `as` says otherwise — it has to agree with `tenancy { claim }`. */
  tenant:     string
  /** The column holding the standing, if the row carries one. */
  standing?:  string
  /** What the standing is called on the principal. Default `<standing>`. */
  standingAs?: string
  /** The column holding this member's capability grants, if the row carries one.
   *  Emitted as `auth().capabilities` (`FJS-D151`), which is the name litestone's
   *  own grid reads — so it is not renameable the way a tenant claim is.
   *
   *  It is read HERE rather than off the session for the reason the standing is:
   *  a capability is always per tenant (`FJS-D149`), and the same person holds a
   *  different set in each. Resolved per request from the row already in hand,
   *  cached nowhere. */
  capabilities?: string
  /** What the tenant claim is called on the principal. Default `<tenant>`. */
  as?:        string
  /** Relations to read alongside the row — `['workspace']` puts the tenant's
   *  own row one join away rather than one query away, which is what a status
   *  check on it costs otherwise. */
  include?:   string[]
  /** How a caller names the tenant, quoted into the refusal when they named
   *  none — `'the X-Workspace-Id header or ?workspace_id='`. `tenantFrom` is
   *  the only thing that knows, and *this request names no workspace* is not
   *  actionable without it. */
  namedBy?:   string
}

/** Where this call's resolved membership row is parked, so a caller can read
 *  the rest of it without a second query. */
export const MEMBERSHIP = 'membership'

/** A grant column reaches here as a JSON array, as `null`, or absent. All three
 *  mean *these are the capabilities this membership holds* and two of them mean
 *  none; anything else is a column that is not a grant, which is worth saying
 *  rather than coercing into an empty set that reads as a caller holding nothing. */
function asCapabilityList(v: unknown): string[] {
  if (v == null) return []
  if (Array.isArray(v)) return v.map(String)
  throw new Error(
    `membershipClaim: the capabilities column holds ${typeof v}, not a list. ` +
    `A grant column is declared \`Capability[]\` in the seed — this one is not, ` +
    `and emitting it as auth().capabilities would grade every capability check against it`)
}

export function membershipClaim(opts: MembershipClaimOptions): DescribedResolver {
  const claimName    = opts.as ?? opts.tenant
  const standingName = opts.standingAs ?? opts.standing

  const resolver = async function membershipClaim(ctx: ServiceContext, user: ServiceContext['auth']['user'] | null) {
    // A GUEST cannot hold a membership. The resolver runs for a caller with no
    // session now — that is what lets a bearer-token claim reach a row policy —
    // so this refuses by name rather than reading `userId` off nothing and
    // querying `where: { userId: undefined }`, which matches the first row with
    // a null column and would hand a stranger someone else's standing.
    if (!user) {
      ctx.locals[NO_CLAIM] = { reason: 'refused' } satisfies NoClaim
      return {}
    }

    // A request names its tenant however the app says; work with no request
    // behind it named one when it was enqueued, and that is the fallback.
    //
    // Without it a job under row tenancy has no legal tenant at all —
    // `tenantFrom` reads a header a queue does not have — so every handler that
    // touches scoped rows reaches for `asSystem()`, which drops the gate, the
    // row policies and the audit actor together to relax exactly one of them
    // (`FJS-384`). The membership row is still READ HERE, for this actor and
    // this tenant, so a caller who lost the membership between asking and
    // running is refused rather than replayed.
    const tenant = opts.tenantFrom(ctx) ?? requestMeta()?.tenant ?? null

    // Not the same answer as the one below, and collapsing them produces a
    // refusal that names nothing: *you do not belong to the tenant this
    // request names*, to a request that named none.
    if (!tenant) {
      ctx.locals[NO_CLAIM] = { reason: 'unnamed', namedBy: opts.namedBy } satisfies NoClaim
      return {}
    }

    // asSystem(): membership is what DECIDES this caller's access, so it cannot
    // be read through a client already scoped by that access — and under a
    // declared `@@gate` the membership model is typically unreadable at the
    // level a caller with no standing yet holds.
    const db  = ctx.locals.db as LitestoneClient | undefined
    const sys = typeof db?.asSystem === 'function' ? db.asSystem() : db

    // Reading an unknown property off a Litestone client THROWS rather than
    // answering undefined, so the probe is itself a throwing expression — the
    // same shape `tenantClaimGuard` and `autoFilter` use. Its message names the
    // model and the schema, which is better than anything this function could
    // say, so it travels as it is; the refusal below is for a client that is
    // not Litestone's and simply has nothing there.
    const table = sys?.[opts.model] as { findFirst?: (a: Record<string, unknown>) => Promise<unknown> } | undefined

    if (typeof table?.findFirst !== 'function') throw new BadRequest(
      `membershipClaim: no accessor '${opts.model}' on the client. ` +
      `A model's accessor is its name with a lower first letter — ` +
      `\`model WorkspaceMember\` is \`workspaceMember\`.`,
    )

    const row = await table.findFirst({
      where: { [opts.tenant]: tenant, [opts.subject]: (user as { userId?: string }).userId },
      ...(opts.include?.length
        ? { include: Object.fromEntries(opts.include.map(r => [r, true])) }
        : {}),
    }) as Record<string, unknown> | null

    // The whole of the safety. No row is no claim — a caller naming a tenant
    // they do not belong to comes out of here holding nothing, which is an
    // empty screen and a gate that grades them a stranger, rather than a full
    // one belonging to somebody else.
    if (!row) { ctx.locals[NO_CLAIM] = { reason: 'refused' } satisfies NoClaim; return {} }

    ctx.locals[MEMBERSHIP] = row

    return {
      [claimName]: tenant,
      ...(standingName && opts.standing ? { [standingName]: row[opts.standing] } : {}),
      // An absent column and an empty grant are the same answer and both are
      // legitimate — a membership that holds no capabilities is what a fresh
      // viewer is — so this normalizes rather than refusing. What it will not do
      // is emit a non-list: litestone throws by name on one, naming this
      // resolver, and a JSON column read back as `null` is the ordinary case.
      ...(opts.capabilities ? { capabilities: asCapabilityList(row[opts.capabilities]) } : {}),
    }
  }

  // What this resolver IS, for a tool that has to write it down.
  //
  // A resolver is a function, so the only thing a snapshot can otherwise say
  // about one is its name — and *the app has a resolver called membershipClaim*
  // is not the fact worth committing. Which model proves membership, which
  // column holds the caller, which holds the tenant and what the claims are
  // called are the four that decide who a request turns out to be, and all four
  // are in this closure.
  //
  // `tenantFrom` is deliberately absent — a function, which a diff cannot grade.
  // `namedBy` is NOT: it is a constant the app wrote, and once a resolver is
  // installed it is the only static answer to *how does a request name its
  // tenant*, which the tenancy declaration's own `resolve` stops answering.
  // A hand-written resolver may carry a `describe` of its own; one that does not
  // is reported by name, which is honest and is what it is.
  const described = resolver as DescribedResolver
  described.describe = () => ({
    kind:       'membership',
    model:      opts.model,
    subject:    opts.subject,
    tenant:     opts.tenant,
    standing:   opts.standing   ?? null,
    standingClaim: (standingName && opts.standing) ? standingName : null,
    capabilities: opts.capabilities ?? null,
    claims:     [claimName,
                 ...(standingName && opts.standing ? [standingName] : []),
                 ...(opts.capabilities ? ['capabilities'] : [])],
    include:    opts.include    ?? [],
    namedBy:    opts.namedBy    ?? null,
  })

  return described
}

/** A resolver that can say what it is — `junction principal` reads this, and an
 *  app writing its own may carry one. */
export type DescribedResolver = PrincipalResolver & { describe: () => PrincipalDescription }

/** What a principal resolver can say about itself to a tool that writes it down. */
export interface PrincipalDescription {
  kind:     string
  model:    string | null
  subject:  string | null
  tenant:   string | null
  standing: string | null
  /** What the standing is CALLED on the principal. Stated rather than read off
   *  the end of `claims`, which was only the standing while a resolver emitted
   *  exactly two: the third claim took the label the moment one existed. */
  standingClaim?: string | null
  /** The column holding this membership's capability grants, where it has one.
   *  Emitted as `auth().capabilities`, the one claim name the framework fixes. */
  capabilities?: string | null
  /** The claim NAMES this resolver can emit. Never values — a value is a caller. */
  claims:   string[]
  include:  string[]
  /** How a caller names the tenant, as the app words it. Constant, so committable. */
  namedBy:  string | null
}

// ─── describePrincipalRealm ──────────────────────────────────────────────────
//
// Who a caller ARRIVES as, and who they BECOME before the Data boundary.
//
// `db/access.snapshot.md` commits the predicate — `workspaceId !=
// auth().workspaceId` — and the `snapshots` CI phase fails a stale one. Nothing
// commits its INPUT: who emits that claim, off which request, verified against
// which model. So a resolver that emits the wrong tenant leaves every artefact
// byte-identical and every read answering somebody else's rows (`FJS-514`).
//
// Read off a BUILT app for the same reason `junction surface` is: a resolver is
// wired in application code and no file tree can answer which one an app ended
// up with.
//
// The one thing deliberately NOT derived is the value→level mapping. A standing
// is graded by `getLevel`, which is a function an app passes to `GatePlugin`,
// and a client exposes plugin NAMES rather than instances — so the values are
// reported from the schema's own enum and the mapping is named as app code. The
// check that executes it is litestone's `verifyGateLadder`; guessing it here
// would be a second answer to a question that already has an executed one.

/** The tenancy claim's own name and how a request names its tenant. */
export interface PrincipalRealm {
  tenancy:   { strategy: string; column: string | null; claim: string | null; resolve: string | null } | null
  resolver:  { name: string; described: PrincipalDescription | null } | null
  /** Models the schema exempts from tenancy by name. */
  exempt:    string[]
  /** Models scoped through a parent rather than a column of their own. */
  delegated: string[]
  /** Models carrying the tenant column. */
  scoped:    string[]
  /** Whether a schema was reachable at all — false under `strategy database`,
   *  where the client is per request and nothing app-wide holds one. */
  hasSchema: boolean
  /** The standing column's declared values, where it is an enum. */
  standing:  { column: string; claim: string; values: string[] } | null
  /** The config paths a tenant may override (`FJS-D126`), or null where the app
   *  installs no resolver. Empty is a resolver with an empty list, which is a
   *  different statement from no resolver at all. */
  tenantConfigKeys: string[] | null
}

export function describePrincipalRealm(app: unknown, db: unknown): PrincipalRealm | null {
  const resolverFn = (app as Record<symbol, unknown>)?.[PRINCIPAL_RESOLVER] as
    (PrincipalResolver & { describe?: () => PrincipalDescription }) | undefined

  // Two sources and they are not interchangeable. `createApp({ db })` has one
  // client and the declaration is on it; `createApp({ tenants })` has none — a
  // client is per request — so the registry is the only thing holding it, and
  // asking `app.db` there answers *no tenancy* about an app that is nothing but.
  const registry = (app as Record<symbol, unknown>)?.[TENANT_REGISTRY] as
    { tenancy?: ResolvedTenancy | null } | undefined
  const t = tenancyOf(db) ?? registry?.tenancy ?? null

  // The model breakdown needs a schema, and under `strategy database` there is
  // no app-wide client to read one off. Opening a tenant to get it would make a
  // description tool create a database file, so it is reported absent instead —
  // which is also the honest answer: that strategy scopes nothing by predicate,
  // so there is no per-model rule to break down.
  const schema = (db as { $schema?: { models?: ModelLike[]; enums?: EnumLike[] } })?.$schema ?? null
  if (!t && !resolverFn) return null

  const described = typeof resolverFn?.describe === 'function' ? resolverFn.describe() : null

  const exempt: string[] = []
  const delegated: string[] = []
  const scoped: string[] = []

  for (const model of schema?.models ?? []) {
    const attrs = model.attributes ?? []
    if (attrs.some(a => a.kind === 'tenant' && a.mode === 'none')) { exempt.push(model.name); continue }
    if (!attrs.some(a => a.kind === 'deny' && a.generated === 'tenancy')) continue
    const column = t?.column
    if (column && model.fields?.some(f => f.name === column)) scoped.push(model.name)
    else delegated.push(model.name)
  }

  // The standing's VALUES where the column is an enum — which is the half a
  // diff can grade. A role added to the ladder and not to the app's `getLevel`
  // is a caller silently graded at whatever the default answers, and the enum
  // gaining a member is the visible edge of it.
  let standing: PrincipalRealm['standing'] = null
  if (described?.standing && described.model) {
    const owner = (schema?.models ?? []).find(m => modelAccessorMatches(m.name, described.model as string))
    const field = owner?.fields?.find(f => f.name === described.standing)
    const values = (schema?.enums ?? []).find(e => e.name === field?.type?.name)?.values ?? []
    standing = { column: `${owner?.name ?? described.model}.${described.standing}`,
                 claim: described.standingClaim ?? described.standing,
                 values: values.map(v => (typeof v === 'string' ? v : (v as { name: string }).name)) }
  }

  return {
    tenancy:  t ? { strategy: t.strategy, column: t.column ?? null, claim: t.claim ?? null,
                    resolve: t.resolve ? describeResolution(t.resolve) : null } : null,
    resolver: resolverFn ? { name: resolverFn.name || 'anonymous', described } : null,
    hasSchema: !!schema,
    tenantConfigKeys: (app as { tenantConfig?: { keys?: string[] } | null })?.tenantConfig?.keys ?? null,
    exempt, delegated, scoped, standing,
  }
}

interface ModelLike { name: string; attributes?: Array<{ kind?: string; mode?: string; generated?: string }>; fields?: Array<{ name: string; type?: { name?: string } }> }
interface EnumLike  { name: string; values?: Array<string | { name: string }> }

// `workspaceMember` ⇄ `WorkspaceMember`, without importing the inflector for a
// comparison that is a case fold: an accessor is the model name with a lowered
// first letter, and `accessorCandidates` owns the plural direction that this is
// not asking about.
function modelAccessorMatches(modelName: string, accessor: string): boolean {
  return modelName === accessor ||
         modelName.charAt(0).toLowerCase() + modelName.slice(1) === accessor
}

// ─── A write nothing announced ───────────────────────────────────────────────
//
// `callService` is the single announcement point, so a mutation that never went
// through a service told nobody: a `db.asSystem()` write in a job, a raw route
// writing through the client directly, a Litestone plugin. Every open tab kept
// the stale row with a 200 (FJS-010). Litestone's own `onEvent` is fixed at
// `createClient`, which is before Junction exists — `$tapEvents` is the
// post-construction half it grew for this (FJS-D04).
//
// The tap fires for EVERY write, service writes included, so `insideServiceCall()`
// is what stops each mutation being broadcast twice. That check draws the line
// at *did a service announce this*, not *is a request in flight*.
//
// A write announces in one of two shapes, and which one is Litestone's to say
// (`scope`). One that read its row back is broadcast as `created`/`updated`/
// `removed` carrying that row. One that did not — every bulk statement, and a
// `select: false` write — is broadcast as `changed` carrying a count, because
// the only honest answer to *N rows you cannot see have changed* is to ask the
// query again (FJS-307).
//
// Two things it cannot do, both reported rather than guessed:
//
//   • A model no service is built over has nowhere to announce to. Silent by
//     design — an app is free to have tables its API does not expose.
//   • A FUNCTION `channel:` resolver takes `(rows, ctx)`, and an orphan write
//     has no ServiceContext to give it. The bus still fires; the socket
//     broadcast is skipped with one warning per service, because inventing a
//     ctx would hand the app's own resolver a principal nobody authenticated.
// ─── registerAuditMetrics ─────────────────────────────────────────────────
// Put *is the audit trail still being written* on /metrics.
//
// `fireLog` is fire-and-forget by design — the row is a side effect of a write
// that already succeeded and must never fail it — so a trail that has stopped
// recording produces one warning on stderr and then nothing at all, which is
// indistinguishable from an app doing no work. That is the same silence
// `FJS-327` and `FJS-328` were about, one realm over, and the answer there was
// the same: make the absence countable.
//
// Registered rather than polled, and SYNCHRONOUS because `registerMetricsSource`
// takes `fn()` directly — `$logStats()` reads a plain object, so the scrape
// costs nothing and cannot await inside a metrics response.
//
// Silent where the client is not a Litestone one or predates the counters:
// metrics must never be the reason an app does not boot.
export function registerAuditMetrics(app: unknown, db: unknown): void {
  const register = (app as { registerMetricsSource?: (n: string, f: () => unknown) => void })?.registerMetricsSource
  if (typeof register !== 'function') return

  let stats: (() => unknown) | undefined
  // Probed inside a try — a Litestone client throws on an unknown property.
  try { stats = (db as { $logStats?: () => unknown }).$logStats } catch { return }
  if (typeof stats !== 'function') return

  register.call(app, 'audit', () => stats())
}

// ─── installLogContext ────────────────────────────────────────────────────
// Tell the Data boundary WHERE a write came from, so an audit row can be
// joined to the request that caused it.
//
// The trail already recorded who (`actorId`) and what (`model`, `records`,
// `before`/`after`) and nothing at all about the request — no correlation id,
// no ip, no user agent, no tenant — so a log line and the audit row from the
// same request could not be joined by anything. Every audit package in the
// field records ip/user-agent/url; none of them records a correlation id,
// which is the one that makes the rest worth having.
//
// **The direction is forced and is the whole reason this is a closure.**
// Litestone cannot import junction (Invariant 1) and must not learn that a
// request exists; junction hands down a function over its OWN stores and
// litestone calls it when it builds an entry. Same shape as `createClient({
// now })`, and the same reason: the answer changes per call, so it is asked
// for rather than read once.
//
// `source` stands where laravel-auditing puts `url`. A URL is the wrong shape
// here — the same write arrives over HTTP, over a socket frame that has no URL,
// and from a job with no request at all, while `orders.pay` is one answer for
// all three, and `origin` beside it says which of the three it was.
//
// Silent where the client is not a Litestone one, or is too old to have the
// setter: this adds columns to a trail and must never be the reason an app
// does not boot.
export function installLogContext(db: unknown): (() => void) | null {
  let install: ((fn: unknown) => () => void) | undefined
  // Probed inside a try — a Litestone client throws on an unknown property
  // rather than answering undefined.
  try { install = (db as { $logContext?: (fn: unknown) => () => void }).$logContext } catch { return null }
  if (typeof install !== 'function') return null

  return install(() => {
    const meta = requestMeta()
    const call = currentCall()
    // A write with no request behind it — a job, a seed, a migration — answers
    // nulls rather than nothing, so the columns are consistently present.
    return {
      correlationId: meta?.correlationId ?? null,
      source:        call?.service ? `${call.service}.${call.method ?? '?'}` : null,
      origin:        meta?.origin ?? null,
      ip:            meta?.client?.ip ?? null,
      userAgent:     meta?.client?.userAgent ?? null,
      // The call's resolved tenant first: `withTenantDb` puts it on locals, and
      // that is the one the rows were actually written under. `meta.tenant` is
      // the other direction — work that STATED its tenant with no request.
      tenant:        (call?.locals?.tenantId as string | undefined) ?? meta?.tenant ?? null,
      // Support mode. The session resolves to the SUBJECT, so nothing below
      // this line knows an operator exists — the trail would file every
      // impersonated write under the person it was done to, which is the
      // failure the feature exists to prevent.
      operatorId:    meta?.user?.support?.operatorId ?? null,
      episodeId:     meta?.user?.support?.episodeId  ?? null,
    }
  })
}

// ─── installQueryTelemetry ────────────────────────────────────────────────
//
// Every query the Data boundary runs, on the telemetry bus, attributed to the
// call it happened inside.
//
// **It is installed ONCE on the root client and never per request.** `$tapQuery`
// is a root-client member: a `$setAuth` proxy does not carry it, and a Litestone
// client THROWS on an unknown property rather than answering `undefined`
// (Invariant: `'x' in db`, never `typeof db.x`). The per-request version read
// `typeof scopedDb.$tapQuery` inside `getTable`, so registering ONE telemetry
// listener anywhere turned every AUTHENTICATED service call into a 500 while
// anonymous ones — which hold the root client — kept working (`FJS-673`). The
// devtools console registers four listeners, so opening it in dev killed the
// app for every signed-in user.
//
// Attribution comes from the call in scope rather than from a captured `ctx`,
// which is what makes one tap correct for every concurrent request: the ALS
// store is the only thing that knows which call a query belongs to, and a
// per-request tap on a shared client would have misattributed every one of them.
//
// Observer tier — a throw in a listener is the telemetry bus's problem and must
// never reach the query that was being measured.
export function installQueryTelemetry(
  app: { telemetry?: { emit: (event: string, data: unknown) => void; hasListeners?: () => boolean } },
  db:  unknown
): (() => void) | null {
  const telemetry = app?.telemetry
  if (!telemetry) return null

  let tap: ((fn: (e: LitestoneQueryEvent) => void) => () => void) | undefined
  try {
    const c = db as { $tapQuery?: unknown }
    if (c && typeof c === 'object' && '$tapQuery' in c && typeof c.$tapQuery === 'function')
      tap = c.$tapQuery as typeof tap
  } catch { /* not a Litestone client, or one predating $tapQuery */ }
  if (!tap) return null

  return tap((event: LitestoneQueryEvent) => {
    if (typeof telemetry.hasListeners === 'function' && !telemetry.hasListeners()) return
    const call = currentCall()
    telemetry.emit('litestone.query', {
      ...event,
      telemetryId: call?.telemetryId ?? null,
      isSystem:    !call?.auth?.user,
    })
  })
}

export function announceDataWrites(
  app: {
    services: { list: () => string[]; get: (n: string) => unknown }
    events?:  { emit: (event: string, data: unknown) => void }
    channels?: unknown
  },
  db: unknown
): () => void {
  // Probed inside a try: a Litestone client THROWS on an unknown property
  // rather than answering undefined, so feature-detection is itself a throwing
  // expression. A client predating $tapEvents, or anything that is not one,
  // simply does not get this — the app runs exactly as it did before.
  let tap: ((fn: (e: LitestoneWriteEvent) => void) => () => void) | undefined
  try {
    const fn = (db as { $tapEvents?: unknown }).$tapEvents
    if (typeof fn === 'function') tap = fn as typeof tap
  } catch { /* not a Litestone client, or an older one */ }
  if (!tap) return () => {}

  const PAST: Record<string, string> = { create: 'created', update: 'updated', remove: 'removed' }

  // model name → EVERY service over it, built on first use: services are
  // registered during the start phases and this installer runs before them.
  //
  // A SET and not one name (`FJS-765`). Keyed to a single service, whichever
  // claimed a spelling last owned the model and every other service over it was
  // silently unsubscribed from writes it did not make itself — measured on two
  // services over one `Order`: a write through the winner announced only the
  // winner, and an `asSystem()` write announced only the winner, so the loser's
  // subscribers held a stale row with nothing said. Which one won was
  // registration order, so it moved when a file was renamed.
  let index: Map<string, Set<string>> | null = null
  const warned = new Set<string>()

  const servicesFor = (model: string): string[] => {
    if (!index) {
      index = new Map()
      // ── Every spelling, not one ──────────────────────────────────────────
      //
      // This used to index a single key per service — `svc.model ?? singularize(name)`
      // — and compare it against Litestone's own model name. It never matched
      // for any conventionally named service, so the whole of this function's
      // reason to exist was dead: a write outside its own service announced
      // NOTHING, in every app, since FJS-010 (FJS-464).
      //
      // Two things defeat one key. `svc.model` is an ACCESSOR and may
      // legitimately be the plural — `createBaseService({ model: 'posts' })`
      // is documented and supported — while Litestone announces `Post`. And
      // `singularize(name)` was unreachable, because `createService` fills
      // `model` with the service NAME when a file declares none, so the `??`
      // never took its right-hand side.
      //
      // `accessorCandidates` is the one owner of the set of spellings a name
      // can take (Invariant 2, the same table `getTable` and `_gateLevels`
      // walk), so both are expanded through it rather than through a rule
      // written again here.
      const claim = (spelling: string | undefined, name: string) => {
        if (!spelling) return
        for (const candidate of accessorCandidates(spelling)) {
          const key = candidate.toLowerCase()
          let set = index!.get(key)
          if (!set) index!.set(key, set = new Set())
          set.add(name)
        }
      }
      // A DECLARED `model:` is the only spelling that service claims; a service
      // that declares none is claimed by its own name. Two passes with the
      // declared one overriding was the old shape and it left the derived claim
      // standing, so a service named `orders` over `model: 'Invoice'` went on
      // receiving `Order` writes — harmless while one name won a key and an
      // extra wrong announcement now that every claimant gets one.
      for (const name of app.services.list()) {
        const svc = app.services.get(name) as { model?: string } | undefined
        claim(svc?.model ?? name, name)
      }
    }
    const key = model.toLowerCase()
    // The singular fallback covers a model whose name pluralises irregularly
    // in a way no service name reached — `singularize` and `accessorCandidates`
    // are the same table, so this is one more lookup and not a second rule.
    const hit = index.get(key) ?? index.get(singularize(key).toLowerCase())
    return hit ? [...hit] : []
  }

  // ── A background write is graded exactly as a published one is ──────────
  //
  // `publish()` grades every recipient against the schema (`FJS-D175`); this
  // path did not, so every write that went through no service call — a job, a
  // webhook, a cron, a bulk write, `asSystem()` anywhere — put whole rows on
  // every subscribed socket. Measured on a policied `Order`: the service path
  // reached 0 of 100 anonymous sockets and `asSystem().create` reached 100 of
  // 100 (`FJS-672`).
  //
  // The rule is not re-implemented here: the channel manager owns the fan-out
  // and the cohorts and litestone owns who may read. What this side has to
  // supply is the two facts a `ServiceContext` would have carried — the client
  // the rule lives on, and WHICH model the payload is a row of. The accessor is
  // the service's declared `model:` first and its name only as a fallback, so a
  // service whose name maps to no model still grades rather than refusing
  // everybody (`FJS-700`).
  const sendToChannel = (name: string, event: string, payload: unknown, mode: 'row' | 'gate' = 'row'): void => {
    const svc = app.services.get(name) as { channel?: unknown; model?: string } | undefined
    const decl = svc?.channel
    if (decl === undefined || decl === false) return
    if (typeof decl !== 'string') {
      if (!warned.has(name)) {
        warned.add(name)
        console.warn(
          `[Junction] '${name}' declares a function channel: and a write reached it outside any ` +
          `service call. The resolver takes (rows, ctx) and there is no request context here, so ` +
          `this write went to the event bus but not to any socket. Declare a channel NAME to have ` +
          `background writes broadcast, or route the write through the service.`
        )
      }
      return
    }
    const manager = app.channels as {
      channel?:    (n: string) => { send?: (event: string, data: unknown) => void }
      sendGraded?: (
        channelId: string, event: string, payload: unknown,
        src: { db: unknown; accessor: string; label?: string }, mode?: 'row' | 'gate'
      ) => Promise<void>
    } | undefined
    if (typeof manager?.sendGraded === 'function') {
      // Duck-typed like every other reach into the manager here, so a channel
      // implementation predating grading still receives the announcement.
      manager.sendGraded(decl, `${name} ${event}`, payload, {
        db:       db,
        accessor: svc?.model ?? name,
        label:    name,
      }, mode).catch(() => { /* a dead socket is not a background job's problem */ })
      return
    }
    const ch = manager?.channel?.(decl)
    if (!ch?.send) return
    try { ch.send(`${name} ${event}`, payload) }
    catch { /* a dead socket is not a background job's problem */ }
  }

  return tap((e) => {
    if (!e.model) return

    // ── A state move ──────────────────────────────────────────────────────
    // A transition is a row change and announces like one. It arrives under
    // its own event name rather than a CRUD one, and this used to drop it —
    // so a move made outside the service that OWNS the model reached no bus
    // subscriber and no open tab. That is not a rare shape: a webhook settling
    // an order, a job advancing a state, anything calling `db.x.transition()`
    // from another service. The same failure as the bulk writes in FJS-307,
    // and just as silent: the write succeeds, the screen does not move.
    //
    // Announced under the MOVE's name (`orders pay`), which is exactly what
    // callService announces when the same transition goes through the owning
    // service — so a subscriber has one event to handle either way, and the
    // browser store's custom-method branch already merges it as a patch.
    if (e.event === 'transition') {
      if (!e.transition) return
      const record = e.record
      for (const name of servicesFor(e.model)) {
        if (announcedInCommitScope(name) || announcingService() === name) continue
        // No row to hand over — the same position a `select: false` write is in
        // below, and it takes the same answer rather than a guess.
        if (record === null || record === undefined) {
          const detail = { model: e.model, operation: e.transition, count: e.count ?? 1 }
          app.events?.emit(`${name}:changed`, detail)
          sendToChannel(name, 'changed', detail, 'gate')
          continue
        }
        app.events?.emit(`${name}:${e.transition}`, record)
        sendToChannel(name, e.transition, record)
      }
      return
    }

    const past = PAST[e.event as string]
    if (!past) return
    // A named move is announced by the `transition` event above, and Litestone
    // sets this key on the update only when that event is really coming. One
    // write is one announcement — a store merging the same row twice is
    // harmless and a handler that appends or counts or raises a toast is not
    // (the rule `refuseDoubleBroadcast` enforces for the service path).
    if (e.transition) return
    const row = e.result
    // The write is already covered by callService's announcement point — but
    // only for the service that call is running. A write to ANOTHER model from
    // inside a hook (the audit row an orders hook writes) is not covered by
    // `orders created` and still announces under its own name.
    //
    // The comparison survives the emitter's setImmediate because ALS propagates
    // to a callback through the scheduling, so the store read here is the one
    // that was active at the write.
    //
    // Under a transaction it is not, and that is what the commit scope answers:
    // litestone BUFFERS a transaction's events to the commit, so they arrive
    // with the OUTERMOST call's span in force and this comparison misses for
    // every inner one — measured, three events for one nested create
    // (`FJS-682`). `announcedInCommitScope` is the same question asked of the
    // transaction rather than of the call.
    for (const name of servicesFor(e.model)) {
      if (announcedInCommitScope(name) || announcingService() === name) continue

    // ── A write with no row to hand over ──────────────────────────────────
    // Two arrive here and they are the same problem: a bulk statement answers
    // `{count}` and never built the rows, and a `select: false` write skipped
    // its RETURNING. Both changed rows some open list is showing. Dropping them
    // is what this line used to do, so a job that `createMany`d a hundred rows
    // left every tab stale with a 200 (FJS-307).
    //
    // One name for all three operations, because the only honest answer on the
    // other side is the same for each: ask the query again. Which operation it
    // was travels in the payload for a bus subscriber that cares.
      if (row === null || row === undefined) {
        const detail = { model: e.model, operation: e.operation ?? past, count: e.count ?? null }
        app.events?.emit(`${name}:changed`, { ...detail, where: e.where })
        // `where` stops at the bus, which is in-process. A channel goes to every
        // subscribed browser and a filter is made of the caller's own values —
        // `deleteMany({ where: { resetToken } })` would put one on the wire.
        sendToChannel(name, 'changed', detail, 'gate')
        continue
      }

      app.events?.emit(`${name}:${past}`, row)
      sendToChannel(name, past, row)
    }
  })
}

// ─── Tenancy ─────────────────────────────────────────────────────────────────
//
// Which tenant a request is for is a Data-realm declaration — `tenancy { }` in
// the schema — and an API-realm question, because only the request knows the
// host, the header and the principal. So the DECISION is asked of Litestone
// (`registry.tenantFor(...)`, which applies the declared `resolve`) and this
// side contributes what a transport has and what a refusal's status code is.
// The alternative was a second reading of `resolve subdomain` living up here,
// which is how two answers to one question drift apart.
//
// Two strategies, two shapes of work:
//
//   database  one file per tenant. The client itself changes per request, so
//             this hook resolves the id and swaps `ctx.locals.db`.
//   row       one database, a tenant column. Nothing to swap — the policies
//             compiled from the schema already scope every query by the
//             principal's own claim. What CAN go wrong is a principal that
//             carries no claim, which reads as an empty screen with a 200, and
//             `tenantClaimGuard` refuses that by name.

export interface TenantResolution { kind: 'subdomain' | 'header' | 'claim'; name: string | null }

export interface ResolvedTenancy {
  strategy: 'database' | 'row'
  column?:  string
  claim?:   string
  resolve?: TenantResolution | null
}

/** The surface `withTenantDb` needs — a Litestone TenantRegistry satisfies it. */
export interface TenantRegistryLike {
  tenancy?:   ResolvedTenancy | null
  tenantFor?: (from: { host?: string | null; headers?: Record<string, unknown> | null; principal?: unknown }) => string | null
  get:        (id: string) => Promise<LitestoneClient>
  exists?:    (id: string) => boolean
  /**
   * Pin a pooled client for the length of this request; the returned function
   * releases it. Optional, because the registry is duck-typed across the
   * dependency boundary and an older litestone has no pool lease.
   *
   * Without it the pool cannot tell a client a request is holding from one
   * nobody has, so it must never close what it evicted and the handles come
   * back only on a collection that file-descriptor pressure does not trigger
   * (`FJS-640`). A request IS the unit of work here, so this is the one place
   * that answer is already known.
   */
  retain?:    (id: string) => () => void
}

declare module './context.ts' {
  interface ServiceContextLocals {
    /**
     * The tenant this call is for. Assigned under BOTH strategies and read by
     * everything downstream that needs the answer — `tenantOf(ctx)` is the
     * accessor.
     *
     * Two assignment points and no third: `withTenantDb`, which resolves it
     * from the request under `strategy database`, and `applyClaims`, which
     * lifts it off the principal under `strategy row` when the claim it merged
     * is the one the schema names. Before it was assigned under row tenancy at
     * all, three subsystems with no request in hand — the cache key, the
     * outbox relay, a queued job — each answered the question themselves and
     * each answered it wrong.
     */
    tenantId?: string
  }
}

/**
 * Which tenant is this call for — one owner, both strategies.
 *
 * `null` where the app declares no tenancy, and where a call legitimately has
 * no tenant: an anonymous read under `strategy row`, a service over a
 * `@@tenant(none)` model, a job the app runs on its own behalf.
 */
export function tenantOf(ctx: ServiceContext): string | null {
  return ctx.locals?.tenantId ?? null
}

/** The tenancy declaration off a client, or null. Reading an unknown property
 *  off a Litestone client THROWS, so the probe is itself a throwing
 *  expression — the same shape `tenantClaimGuard` and `autoFilter` use. */
function tenancyOf(client: unknown): ResolvedTenancy | null {
  try { return (client as { $tenancy?: ResolvedTenancy | null })?.$tenancy ?? null } catch { return null }
}

/**
 * Under `strategy row`, put the tenant where a reader with no principal can
 * find it.
 *
 * Nothing swaps a client on this strategy, so the tenant exists only as a
 * value inside the principal — which is unreachable for a cache key built
 * from a service and a query, for a relay sweeping a table, and for a job
 * running an hour after the request that asked for it.
 *
 * The claim is named by the schema and never guessed. `tenancy { claim }`
 * says which one carries the tenant, so a cart token or an invitation claim —
 * both legitimate claims on a principal — set nothing here.
 *
 * Two sources and the resolver's answer wins: a resolver runs per call and is
 * the reason `membershipClaim` exists, where `sessionFields` fixes the value
 * at sign-in for an app whose caller has one tenant for the life of a session.
 */
function liftRowTenant(ctx: ServiceContext, client: unknown, claims?: PrincipalClaims): void {
  const t = tenancyOf(client)
  if (t?.strategy !== 'row' || !t.claim) return

  const fromClaims = claims?.[t.claim]
  const user       = ctx.auth?.user
  const fromUser   = user ? (toDataPrincipal(user) as Record<string, unknown>)[t.claim] : undefined
  const value      = fromClaims ?? fromUser

  if (value != null) ctx.locals.tenantId = String(value)
}

/**
 * Tap a tenant's client for writes that went through no service — once.
 *
 * `announceDataWrites` is installed on the app's ONE client by `createApp({ db })`.
 * Under `createApp({ tenants })` there is no such client: a shop is a file and
 * the client is per request. So the tap is installed the first time each
 * tenant's client is seen, and a `WeakSet` keeps it to once — a client evicted
 * from the pool and reopened is a new object and is tapped again, which is
 * exactly right.
 *
 * Without it the whole seam is off under `strategy database`: a job writing
 * with `asSystem()`, a webhook moving a row through a Litestone client, a bulk
 * write — none of them reach an open tab. Measured in `example`, where a signed
 * payment webhook settled an order and the seller's screen stayed on `pending`
 * with nothing logged (`FJS-489`); the same shape as `FJS-010` and `FJS-464`,
 * one strategy over.
 */
const _tapped = new WeakSet<object>()
function tapTenantWrites(app: unknown, client: unknown): void {
  if (!client || typeof client !== 'object' || _tapped.has(client as object)) return
  if (!app || typeof app !== 'object') return
  _tapped.add(client as object)
  announceDataWrites(app as Parameters<typeof announceDataWrites>[0], client)
  // The audit trail's provenance, on the same *once per tenant client* seam and
  // for the same reason: under `strategy database` there is no one app client
  // to install it on, and a per-tenant trail with no correlation id is the same
  // hole one strategy over.
  installLogContext(client)
  // Same seam, same reason: `$tapQuery` is a root-client member and there is no
  // one app client to tap under `strategy database`.
  installQueryTelemetry(app as Parameters<typeof installQueryTelemetry>[0], client)
}

/**
 * around hook: put THIS tenant's client on `ctx.locals.db`.
 *
 * Installed by `createApp({ tenants })`. It replaces `withLitestoneDb` rather
 * than composing with it — an app has one `ctx.locals.db` and two hooks
 * assigning it is a race decided by hook order.
 */
export function withTenantDb(registry: TenantRegistryLike, principal?: PrincipalResolver): import('./hooks.ts').AroundHook {
  return async function withTenantDb(ctx, next) {
    const dataPrincipal = ctx.auth?.user ? toDataPrincipal(ctx.auth.user) : null
    const headers   = (ctx.client?.headers ?? {}) as Record<string, unknown>
    const host      = (headers.host ?? headers.Host ?? null) as string | null

    // A caller may STATE the tenant — `app.service('x').find({ locals: { tenantId } })`
    // — and that is the only way work with no request behind it can name one.
    // A job, a scheduled sweep and a webhook replay all arrive with no host, no
    // header and often no principal.
    //
    // The ambient tenant sits between the two: `app.runAs(actor, { tenant })`
    // puts it on the request meta, so a queued job resolves to the tenant that
    // enqueued it without every handler having to thread `locals` through
    // every call it makes. A per-call `locals.tenantId` still wins, because a
    // job legitimately addressing a second tenant said so on the call.
    const stated  = ctx.locals.tenantId
    const ambient = requestMeta()?.tenant ?? null
    const id = stated ?? ambient ?? registry.tenantFor?.({ host, headers, principal: dataPrincipal }) ?? null

    if (!id) {
      const how = registry.tenancy?.resolve
      throw new BadRequest(
        `No tenant on this request. The schema resolves a tenant by ` +
        `${how ? describeResolution(how) : 'nothing — the tenancy block declares no `resolve`'}` +
        `${host ? `, and this request's Host is '${host}'` : ''}. ` +
        `Work with no request behind it names its tenant explicitly: ` +
        `app.runAs(actor, { tenant }, fn) for a whole unit of work, or ` +
        `app.service(name).method(…, { locals: { tenantId } }) for one call.`,
      )
    }

    let client: LitestoneClient
    try {
      client = await registry.get(id)
    } catch (err) {
      // The registry answers one sentence for "no such tenant" and this is the
      // boundary that owns its status. Anything else is a real failure and
      // travels as one.
      const msg = (err as Error)?.message ?? ''
      if (msg.includes('does not exist')) throw new NotFound(`No tenant '${id}'`)
      throw err
    }

    // Hold the pool's lease for exactly as long as this request uses the
    // client. The pool may evict it under us at any point — that is what a
    // pool at capacity does — and the lease is what makes eviction defer the
    // close instead of tearing the connection out mid-request. Released in the
    // `finally` below, on the error path too.
    const release = registry.retain?.(id) ?? (() => {})

    try {
      // The tap goes on the TENANT's client, not on a scoped view of it: a
      // scoped client is a proxy built per call, and tapping one would announce
      // for the length of that call and no longer.
      tapTenantWrites((ctx as { app?: unknown }).app, client)

      ctx.locals.tenantId = id
      ctx.locals.db = dataPrincipal && typeof client?.$setAuth === 'function'
        ? client.$setAuth(dataPrincipal)
        : client

      // A standing is orthogonal to WHICH DATABASE the tenant lives in — an app
      // on this strategy can still want a per-request level — so the resolver
      // runs here too, against the tenant's own client. Wiring it to one strategy
      // would make `createApp({ tenants, principal })` silently do nothing.
      //
      // For a GUEST as well as for a session, exactly as `withLitestoneDb` does
      // twenty lines up. These two hooks are one seam wearing two names, and this
      // one kept the older half of it: a resolver that runs only for a caller who
      // already has a principal cannot serve the population it exists for. In
      // `example` that is a shopper with no account — the cart token is a claim
      // and nothing else can carry it — so every basket call answered 404 under
      // `strategy database` and only under it (`FJS-490`).
      if (principal)
        applyClaims(ctx, client, await principal(ctx, ctx.auth?.user ?? null))

      await warmTenantConfig(ctx)

      await next()
    } finally {
      release()
    }
  }
}

function describeResolution(r: TenantResolution): string {
  if (r.kind === 'subdomain') return 'the request subdomain'
  if (r.kind === 'header')    return `the '${r.name}' header`
  return `the '${r.name}' claim on the principal`
}

const _rowScoped = new WeakMap<object, Map<string, boolean>>()

/** Does this accessor's model carry the tenancy column the schema desugared? */
function isRowScoped(client: unknown, accessor: string): boolean {
  const c = client as { $schema?: { models?: Array<{ name: string; attributes?: Array<{ generated?: string }> }> } } | null
  if (!c || typeof c !== 'object' || !c.$schema?.models) return false

  const key = schemaKey(c)
  let per = _rowScoped.get(key)
  if (!per) { per = new Map(); _rowScoped.set(key, per) }
  if (per.has(accessor)) return per.get(accessor)!

  const candidates = accessorCandidates(accessor)
  const model = c.$schema.models.find(m => {
    const acc = m.name.charAt(0).toLowerCase() + m.name.slice(1)
    return candidates.includes(acc)
  })
  const scoped = !!model?.attributes?.some(a => a.generated === 'tenancy')
  per.set(accessor, scoped)
  return scoped
}

/**
 * before hook: a signed-in caller with no tenant claim sees nothing, loudly.
 *
 * Under `tenancy { strategy row }` every scoped model compiles the claim into
 * its WHERE, so a principal that carries no claim matches no row — a 200 with
 * an empty list, on every screen, which is indistinguishable from a tenant that
 * genuinely has no data. Almost always it means the app never put the column on
 * the session (`sessionFields` in `@frontierjs/auth`).
 *
 * Anonymous is deliberately NOT this hook's business: nobody is not a caller
 * missing a claim, and refusing there would break every public read the app's
 * own `@@gate` and `@@allow` are there to grade.
 */
export function tenantClaimGuard(db: unknown): (ctx: ServiceContext) => void {
  return function tenantClaimGuard(ctx: ServiceContext): void {
    const tenancy = tenancyOf(db)
    if (!tenancy || tenancy.strategy !== 'row' || !tenancy.claim) return

    const user = ctx.auth?.user
    if (!user) return

    const principal = toDataPrincipal(user) as Record<string, unknown>
    if (principal[tenancy.claim] != null) return

    if (!isRowScoped(db, ctx.service)) return

    // Never 401 in any branch. The caller PROVED who they are — a 401 is what a
    // client is built to answer by discarding the token and bouncing to
    // sign-in, so naming a tenant you do not belong to would sign you out of
    // the one you do.
    if (ctx.locals[RESOLVED]) {
      const no = ctx.locals[NO_CLAIM] as NoClaim | undefined

      // An incomplete request rather than a refused one, so 400. Without the
      // split, a caller who named no tenant is told they do not belong to the
      // one this request names, which names nothing.
      if (no?.reason === 'unnamed') throw new BadRequest(
        `This request names no '${tenancy.claim}', and '${ctx.service}' is scoped to it by the schema` +
        (no.namedBy ? ` — name one with ${no.namedBy}.` : '.'),
      )

      throw new Forbidden(
        `You do not belong to the '${tenancy.claim}' this request names, and '${ctx.service}' is scoped ` +
        `to it by the schema. Nothing here is readable at that standing.`,
      )
    }

    throw new Forbidden(
      `This session carries no '${tenancy.claim}', and '${ctx.service}' is scoped to it by the schema — ` +
      `every read would answer an empty list and every write would be refused. ` +
      `Put the column on the session (sessionFields in @frontierjs/auth) when a caller has ONE tenant ` +
      `for the life of a session; resolve it per request with createApp({ principal }) when they have ` +
      `several and pick one — membershipClaim() is the shipped resolver. Or mark the model @@tenant(none).`,
    )
  }
}

export interface LitestoneJsonSchema {
  $schema?: string
  $defs:    Record<string, LitestoneModelDef | LitestoneEnumDef | LitestoneTypeDef | LitestoneFileDef>
}

interface LitestoneModelDef {
  type:                  'object'
  title?:                string
  properties:            Record<string, LiJsonProp>
  required?:             string[]
  additionalProperties?: boolean
}

interface LitestoneEnumDef {
  type:   'string'
  enum:   unknown[]
  title?: string
}

interface LitestoneTypeDef {
  type:                  'object'
  title?:                string
  properties:            Record<string, LiJsonProp>
  required?:             string[]
  additionalProperties?: boolean
}

interface LitestoneFileDef {
  type:                'object'
  'x-litestone-file':  true
  description?:        string
  properties?:         Record<string, unknown>
  required?:           string[]
}

interface LiJsonProp {
  type?:             string | string[]
  format?:           string
  $ref?:             string
  anyOf?:            LiJsonProp[]
  enum?:             unknown[]
  items?:            LiJsonProp
  minLength?:        number
  maxLength?:        number
  minimum?:          number
  maximum?:          number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
  pattern?:          string
  default?:          unknown
  readOnly?:         boolean
}

/**
 * The seed's generated JSON Schema for an app, or null where there is no
 * Litestone client. Exported so the OpenAPI generator can resolve a declared
 * `input:` type NAME into a shape without deriving it a second way — the
 * derivation, its cache and its dynamic import of litestone stay here, which
 * is the whole reason this module is the adapter.
 */
export function appJsonSchema(app: { db?: unknown }, mode: JsonSchemaMode = 'create'): Promise<LitestoneJsonSchema | null> {
  return _deriveJsonSchema(app?.db, mode)
}

export function jsonSchemaToJunctionSchema(
  modelName:  string,
  fullSchema: LitestoneJsonSchema,
  mode:       'create' | 'update' = 'create'
): Schema {
  const modelDef = fullSchema.$defs[modelName]
  if (!modelDef || modelDef.type !== 'object') {
    throw new Error(`Litestone: no object definition found for model '${modelName}'`)
  }

  const required =
    (mode === 'create' ? (modelDef as LitestoneModelDef).required : undefined) ?? []
  const schema: Schema = {}

  for (const [field, prop] of Object.entries(
    (modelDef as LitestoneModelDef).properties ?? {}
  )) {
    const def = mapProp(prop, field, required, fullSchema.$defs)

    // A `readOnly` column's default belongs to the DATA BOUNDARY, not to this
    // validator — on either mode.
    //
    // Litestone emits `readOnly` for every column the caller may not write:
    // `@system`, a tenancy-stamped column, `@version`, `@from`, `@derived`.
    // Several of those also carry a `@default`, and the two together were fatal
    // in create mode: validate() fills a default in for any absent key, so the
    // payload reaching the model named a column the caller never sent, and the
    // Data boundary refused it BY NAME — correctly, and about a key nobody
    // wrote. A `redemptions Int @default(0) @system` made its model uncreatable
    // through any service, with a 403 quoting a column the request did not
    // contain (`FJS-504`).
    //
    // Nothing is lost by dropping it: the default is declared in the seed and
    // Litestone applies it at the write, which is where a default a caller may
    // not override has to be applied anyway.
    if (prop.readOnly === true) delete def.default

    // A PATCH must not invent a value for a key the caller did not send.
    //
    // `mode: 'update'` already drops required-ness — a partial body is the
    // whole point — but it kept every field's `default`, and validate() fills a
    // default in for any absent key. So `PATCH /orders/3 {"note":"x"}` was
    // rewritten as `{ note: 'x', status: 'pending', total: 0, active: true, … }`
    // before it ever reached the model.
    //
    // On an ordinary column that silently reset it. On a column under
    // `@@transitions` it was worse and, mercifully, loud: patching one unrelated
    // field on a shipped order answered
    //   409 Cannot transition order.status from 'shipped' to 'pending'
    // which reads as a bug in the state machine and is not one. Found
    // 2026-08-06 by a Caravan job trying to write a tracking code.
    if (mode === 'update') delete def.default

    schema[field] = def
  }

  return schema
}

/**
 * Presentation travels with the FIELD, not with the type it references.
 *
 * `title` is `@label("Customer")` and `x-messages` is the author's wording for
 * each rule. Both are read off the field's own schema and never off a $ref
 * target: Litestone titles every enum $def with the type name, so following the
 * ref would make `status OrderStatus` call itself "OrderStatus" in every message
 * it appears in. Sierra's field-rules reads them the same way, from the same
 * document, which is what makes the browser and the server say one sentence.
 */
function mapProp(
  prop:     LiJsonProp,
  field:    string,
  required: string[],
  defs:     Record<string, LitestoneModelDef | LitestoneEnumDef | LitestoneTypeDef | LitestoneFileDef>
): FieldDef {
  const def = _mapProp(prop, field, required, defs)
  const raw = prop as LiJsonProp & { title?: string; 'x-messages'?: Record<string, string> }
  if (typeof raw.title === 'string') def.label = raw.title
  const messages = raw['x-messages']
  if (messages && typeof messages === 'object') def.messages = messages
  return def
}

function _mapProp(
  prop:     LiJsonProp,
  field:    string,
  required: string[],
  defs:     Record<string, LitestoneModelDef | LitestoneEnumDef | LitestoneTypeDef | LitestoneFileDef>
): FieldDef {
  if (Array.isArray(prop.type)) {
    const nonNullType = prop.type.find((t) => t !== 'null')
    const synth: LiJsonProp = { ...prop, type: nonNullType }
    const def = _mapProp(synth, field, required, defs)
    def.nullable = true
    return def
  }

  let inner    = prop
  let nullable = false

  if (prop.anyOf) {
    const nonNull = prop.anyOf.find((p) => p.type !== 'null')
    if (nonNull) {
      inner    = { ...nonNull, default: nonNull.default ?? prop.default }
      nullable = true
    }
  }

  if (inner.$ref) {
    const refName = inner.$ref.replace(/^#\/\$defs\//, '')
    const refDef  = defs[refName]

    if (refDef && (refDef as LitestoneFileDef)['x-litestone-file'] === true) {
      return {
        type:     'any',
        required: required.includes(field) || undefined,
        nullable: nullable || undefined,
        default:  inner.default,
      }
    }

    if (refDef && refDef.type === 'object' && !('x-litestone-file' in refDef)) {
      return {
        type:     'object',
        required: required.includes(field) || undefined,
        nullable: nullable || undefined,
        default:  inner.default,
      }
    }

    const enumDef = refDef as LitestoneEnumDef | undefined
    return {
      type:     'string',
      required: required.includes(field) || undefined,
      nullable: nullable || undefined,
      enum:     enumDef?.enum ?? [],
      default:  inner.default,
    }
  }

  const def: FieldDef = {
    type:     resolveType(inner),
    required: required.includes(field) || undefined,
    nullable: nullable || undefined,
    default:  inner.default,
  }

  if (inner.minLength !== undefined) def.minLength = inner.minLength
  if (inner.maxLength !== undefined) def.maxLength = inner.maxLength
  if (inner.minimum   !== undefined) def.min       = inner.minimum
  if (inner.maximum   !== undefined) def.max       = inner.maximum
  if (inner.exclusiveMinimum !== undefined) def.exclusiveMin = inner.exclusiveMinimum
  if (inner.exclusiveMaximum !== undefined) def.exclusiveMax = inner.exclusiveMaximum
  if (inner.type === 'integer') def.integer = true
  if (inner.enum)               def.enum    = inner.enum
  if (inner.pattern !== undefined) def.pattern = inner.pattern

  if (def.type === 'array' && inner.items) {
    def.items = mapProp(inner.items, `${field}[]`, [], defs)
  }

  return def
}

function resolveType(prop: LiJsonProp): FieldDef['type'] {
  switch (prop.format) {
    case 'email':    return 'email'
    case 'uri':
    case 'url':      return 'url'
    case 'uuid':     return 'uuid'
    case 'date-time':
    case 'date':     return 'date'
  }

  switch (prop.type as string) {
    case 'string':  return 'string'
    case 'integer':
    case 'number':  return 'number'
    case 'boolean': return 'boolean'
    case 'array':   return 'array'
    case 'object':  return 'object'
    default:        return 'any'
  }
}

// (LitestoneServiceConfig + LITESTONE_RESERVED lived here to serve
// createLitestoneService, which was folded into createService. Both were dead
// after that merge — the config type described options for a factory that no
// longer existed, and the reserved-key set had no readers. Use
// ServiceDefinition and SERVICE_OPTION_KEYS from core/service.ts.)


/**
 * A one-line summary of the Data realm, for the startup banner.
 *
 * `createApp({ db })` accepts anything table-shaped, so everything here is
 * duck-typed and any failure means "not a Litestone client" rather than an
 * error — a raw bun:sqlite handle has no `$schema` and simply gets no line.
 *
 * What it reports and why:
 *
 *   models      how many the schema actually parsed. The question this whole
 *               line exists to answer is "did the seed load at all", and a
 *               count is the shortest honest form of it.
 *   enums       cheap, and a missing enum is a common cause of a $ref that
 *               will not resolve in the browser later.
 *   gated       n/total. A schema where this reads 0/24 is a schema whose
 *               access control is not declared, which is worth seeing daily.
 *   databases   name → RESOLVED path (driver). The resolved path is the point:
 *               a declared `database main { path … }` silently overrides
 *               createClient's `db:` option, so the file being written is not
 *               always the file that was passed.
 */
export function describeDataRealm(db: unknown): Record<string, unknown> | null {
  try {
    const client = db as {
      $schema?: { models?: unknown[]; enums?: unknown[] }
      $databases?: Record<string, { driver?: string; path?: string }>
    }
    const models = client?.$schema?.models
    if (!Array.isArray(models) || models.length === 0) return null

    const gated = models.filter(m =>
      Array.isArray((m as { attributes?: { kind?: string }[] }).attributes) &&
      (m as { attributes: { kind?: string }[] }).attributes.some(a => a?.kind === 'gate')
    ).length

    const enums = client?.$schema?.enums
    const dbs   = client?.$databases ?? {}

    // Absolute paths are correct and unreadable, so anything under the process
    // CWD still prints relative to it — but the CWD is printed BESIDE them, and
    // that is the whole point rather than a detail.
    //
    // Shortening alone is what hid `FJS-449`. A path is resolved against the
    // process CWD, so a command run from the wrong directory opens a different
    // file — and then printing that file relative to the same CWD renders the
    // right answer and the catastrophic one character-identical: `litestone
    // studio` in `db/` served an empty `db/db/shop.db` for nineteen hours
    // logging `./db/shop.db`, exactly what a correct run logs. A path outside
    // the CWD prints absolute, which is now a signal rather than noise.
    const cwd = process.cwd()
    const short = (p?: string) =>
      !p ? '?' : p.startsWith(cwd + '/') ? '.' + p.slice(cwd.length) : p

    const stores = Object.entries(dbs)
      .map(([name, d]) => `${name} → ${short(d?.path)} (${d?.driver ?? '?'})`)

    return {
      models:    models.length,
      enums:     Array.isArray(enums) && enums.length ? enums.length : undefined,
      gated:     `${gated}/${models.length}`,
      databases: stores.length ? stores.join(', ') : undefined,
      cwd,
    }
  } catch {
    return null           // not a Litestone client — say nothing rather than throw
  }
}
