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
import { NotFound, BadRequest, Unauthorized } from './errors.ts'
import type { ServiceContext, QueryDirectives } from './context.ts'
import { announcingService } from './context.ts'
import { toBulkFailure, partitionBulk, BULK_FAILURES, type BulkFailure } from './envelope.ts'
import { singularize } from '@frontierjs/toolbelt/inflect'
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
}

interface LitestoneClient {
  asSystem(): LitestoneClient
  $setAuth(user: unknown): LitestoneClient
  $tapQuery(fn: (event: LitestoneQueryEvent) => void): () => void
  $transaction?: <T>(fn: (tx: LitestoneClient) => Promise<T>) => Promise<T>
  $schema?: unknown
  $rawDbs?: Record<string, unknown>
  $close?: () => void
  [model: string]: unknown
}

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
  const { $limit, $offset, $orderBy, $select, $populate,
          $search, $withDeleted, $onlyDeleted,
          $withTemplates, $onlyTemplates, ...where } = query

  const limitRaw   = directives.limit       ?? $limit
  const offsetRaw  = directives.offset      ?? $offset
  const orderByRaw = directives.orderBy     ?? $orderBy
  const selectRaw  = directives.select      ?? $select
  const popRaw     = directives.populate    ?? $populate
  const searchRaw  = directives.search      ?? $search
  const withDel    = directives.withDeleted ?? $withDeleted
  const onlyDel    = directives.onlyDeleted ?? $onlyDeleted
  const withTmpl   = directives.withTemplates ?? $withTemplates
  const onlyTmpl   = directives.onlyTemplates ?? $onlyTemplates

  // A limit of 0 is meaningful (count-only), so `??` not `||`. Non-numeric
  // input falls back to the default rather than producing NaN — a NaN limit
  // reaches SQLite as a bind failure, not as "no limit".
  const parsedLimit = Number(limitRaw ?? defaultLimit)
  const limit = Math.min(Number.isFinite(parsedLimit) ? parsedLimit : defaultLimit, maxLimit)

  const parsedOffset = Number(offsetRaw ?? 0)

  return {
    where:        parseWhere(where),
    orderBy:      orderByRaw != null ? parseSort(orderByRaw as SortParam) : undefined,
    offset:       Number.isFinite(parsedOffset) ? parsedOffset : 0,
    limit,
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
 * validation silently did nothing. Normalising in one place is what keeps the
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
  let models: Array<{ name: string }> | undefined
  // Reading an unknown property off a Litestone client throws by design, so
  // even a plain field read is a guarded one here (see autoFilter).
  try {
    models = (client as { $schema?: { models?: Array<{ name: string }> } })?.$schema?.models
  } catch { return accessor }
  if (!Array.isArray(models)) return accessor

  const candidates = accessorCandidates(accessor)
  const camel = (n: string) => n.charAt(0).toLowerCase() + n.slice(1)
  const model = models.find(m => candidates.includes(camel(m.name)))
  return model ? camel(model.name) : accessor
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

export function createLitestoneBase(opts: LitestoneServiceOptions) {
  const {
    model,
    idField    = 'id',
    paginate   = { default: 20, max: 100 },
    softDelete,
    allowBulk  = true,
    bulkMax    = 1000,
  } = opts

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

      const telemetry = ctx.app?.telemetry

      if (telemetry && ctx.telemetryId && typeof scopedDb.$tapQuery === 'function') {
        const stop = scopedDb.$tapQuery((event: LitestoneQueryEvent) => {
          telemetry.emit('litestone.query', {
            ...event,
            telemetryId: ctx.telemetryId,
            isSystem:    !ctx.auth.user,
          })
        })

        if (!ctx._cleanups) ctx._cleanups = []
        ctx._cleanups.push(stop)
      }

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

  function ensureBulkAllowed(op: string): void {
    if (!allowBulk) {
      throw new BadRequest(
        `Bulk ${op} is disabled on this service (set allowBulk: true to enable)`
      )
    }
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

    // Shape recognised by wrapResult → a list envelope carrying errors.
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

      const { rows, total } = await table.findManyAndCount(args)
      return { total, limit: q.limit, offset: q.offset, data: rows }
    },

    async get(ctx: ServiceContext): Promise<unknown> {
      const table = getTable(ctx)
      const q     = parseQuery(ctx.query, 1, 1, ctx.directives)

      if (ctx.id) {
        const where = { [idField]: ctx.id, ...softDeleteFilter() }
        const args: Record<string, unknown> = { where }
        if (q.select)      args.select      = q.select
        if (q.include)     args.include     = q.include
        if (q.withDeleted)   args.withDeleted   = true
        if (q.onlyDeleted)   args.onlyDeleted   = true
        if (q.withTemplates) args.withTemplates = true
        if (q.onlyTemplates) args.onlyTemplates = true

        const record = await table.findUnique(args)
        if (!record) throw new NotFound(`${model} with ${idField}=${ctx.id} not found`)
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
      if (!record) throw new NotFound(`${model} not found`)
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
        const created:  unknown[] = []
        // Seeded with anything the validation hooks already rejected, so a
        // response reports EVERY failed row, not just the ones that reached
        // the database.
        const failures: BulkFailure[] =
          (ctx.locals[BULK_FAILURES] as BulkFailure[] | undefined) ?? []

        for (const row of ctx.data) {
          try {
            created.push(await table.create({ data: row as Record<string, unknown> }))
          } catch (err) {
            failures.push(toBulkFailure(row, err))
          }
        }

        // Shape recognised by wrapResult → a list envelope carrying errors.
        return { data: created, total: created.length, errors: failures }
      }

      const args: Record<string, unknown> = { data: ctx.data }
      if (q.select)  args.select  = q.select
      if (q.include) args.include = q.include

      return table.create(args)
    },

    // update() — full-replace sibling of patch() (Feathers semantics:
    // update replaces the record, patch merges into it). Id-required —
    // there is deliberately no bulk update.
    async update(ctx: ServiceContext): Promise<unknown> {
      if (!ctx.data) throw new BadRequest('Request body is required')
      if (!ctx.id)   throw new BadRequest('update() requires an id — use patch() for query-based writes')

      const table = getTable(ctx)
      const q     = parseQuery(ctx.query, paginate.default, paginate.max, ctx.directives)

      if (softDelete && (ctx.data as Record<string, unknown>)[softDelete] !== undefined) {
        throw new BadRequest(`Cannot set ${softDelete} directly — use remove()`)
      }

      const where = { [idField]: ctx.id, ...softDeleteFilter() }

      // Single round trip: litestone's update() returns null when no row
      // matches — no need for a findUnique existence probe first (which
      // doubled the query count and was a TOCTOU race).
      const args: Record<string, unknown> = { where, data: ctx.data }
      if (q.select)  args.select  = q.select
      if (q.include) args.include = q.include
      const updated = await table.update(args)
      if (!updated) throw new NotFound(`${model} with ${idField}=${ctx.id} not found`)
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
        const where = { [idField]: ctx.id, ...softDeleteFilter() }

        // Single round trip — update() returns null when no row matches.
        const args: Record<string, unknown> = { where, data: ctx.data }
        if (q.select)  args.select  = q.select
        if (q.include) args.include = q.include
        const updated = await table.update(args)
        if (!updated) throw new NotFound(`${model} with ${idField}=${ctx.id} not found`)
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

      const where = { ...q.where, ...softDeleteFilter() }
      return bulkByRow(ctx, 'patch', table, where, (id, version) =>
        table.update({
          where: { [idField]: id },
          data:  { ...(ctx.data as Record<string, unknown>), ...version },
        })
      )
    },

    async remove(ctx: ServiceContext): Promise<unknown> {
      const table = getTable(ctx)
      const q     = parseQuery(ctx.query, paginate.default, paginate.max, ctx.directives)

      if (ctx.id) {
        const where = { [idField]: ctx.id, ...softDeleteFilter() }

        // Single round trip — update()/remove() return null when no row
        // matches, so the findUnique existence probe was pure overhead.
        if (softDelete) {
          const stamped = await table.update({
            where,
            data: { [softDelete]: new Date().toISOString() },
          })
          if (!stamped) throw new NotFound(`${model} with ${idField}=${ctx.id} not found`)
          return stamped
        }

        const removed = await table.remove({ where })
        if (!removed) throw new NotFound(`${model} with ${idField}=${ctx.id} not found`)
        return removed
      }

      ensureBulkAllowed('remove')

      // Safety: refuse to delete the whole table when no filter conditions
      // remain — bulk remove must be scoped by at least one query param.
      if (Object.keys(q.where).length === 0) {
        throw new BadRequest(
          'Bulk delete with no filter conditions is not allowed. ' +
          'Provide at least one query parameter to scope the deletion.'
        )
      }

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

const _jsonSchemaFor = new WeakMap<object, Promise<LitestoneJsonSchema | null>>()

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

function _deriveJsonSchema(client: unknown): Promise<LitestoneJsonSchema | null> {
  const c = client as { $schema?: unknown } | null
  if (!c || typeof c !== 'object' || !c.$schema) return Promise.resolve(null)

  const cached = _jsonSchemaFor.get(c as object)
  if (cached) return cached

  const p = (async () => {
    try {
      // Asserted onto a one-property shape before, which is both a cast the
      // compiler refuses and a probe that could not fail: litestone really does
      // export this, so ask the real module and let the signature be checked.
      const mod = await import('@frontierjs/litestone')
      if (typeof mod.generateJsonSchema === 'function')
        return mod.generateJsonSchema(
          c.$schema as Parameters<typeof mod.generateJsonSchema>[0]
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

  _jsonSchemaFor.set(c as object, p)
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
  // Same normalisation as _gateLevels — matching the literal accessor only
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

const _compiledFor = new WeakMap<object, Map<string, {
  create: import('./schema.ts').CompiledSchema
  patch:  import('./schema.ts').CompiledSchema
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

  let seen = _warnedUnvalidated.get(client)
  if (!seen) { seen = new Set(); _warnedUnvalidated.set(client, seen) }
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
// mark is what lets that second merge recognise its own work and skip it
// (`FJS-231`) — without it every autoloaded service graded its @@gate and ran
// its validator twice per request.
//
// A mark rather than the function's name: dedupe on name alone would let a USER
// hook that happens to be called `gateAuth` suppress the real one, which is
// fail-open on the thing that enforces access.

// A WeakSet rather than a property on the function: it adds nothing a spread,
// a serialiser or an equality check can see, and membership follows the
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

    const jsonSchema = await _deriveJsonSchema(client)
    if (!jsonSchema) return

    let perModel = _compiledFor.get(client as object)
    if (!perModel) { perModel = new Map(); _compiledFor.set(client as object, perModel) }

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
            create: createSchema(jsonSchemaToJunctionSchema(defsKey, jsonSchema, 'create')),
            patch:  createSchema(jsonSchemaToJunctionSchema(defsKey, jsonSchema, 'update')),
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

    // Bulk: validate element-wise and PARTITION. parse() rejects an array
    // outright ("Expected an object"), so this hook used to 400 every bulk
    // create before the service saw it; throwing on the first bad row would
    // make partial success unreachable. Rejected rows are parked for the
    // service to report in errors[].
    ctx.data = Array.isArray(ctx.data)
      ? partitionBulk(ctx, ctx.data, row => compiled[mode].parse(row) as Record<string, unknown>)
      : compiled[mode].parse(ctx.data)
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

  let perModel = _columnsFor.get(c as object)
  if (!perModel) { perModel = new Map(); _columnsFor.set(c as object, perModel) }
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

  let perModel = _versionFor.get(c as object)
  if (!perModel) { perModel = new Map(); _versionFor.set(c as object, perModel) }
  if (perModel.has(accessor)) return perModel.get(accessor)!

  const jsonSchema = await _deriveJsonSchema(client)
  const defsKey    = jsonSchema ? resolveDefsKey(jsonSchema, accessor, c.$schema) : null
  const def        = defsKey ? jsonSchema!.$defs[defsKey] as { 'x-version'?: string } : null
  const field      = typeof def?.['x-version'] === 'string' ? def['x-version'] : null

  perModel.set(accessor, field)
  return field
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

interface WhereKeyProblem { key: string, suggestion: string | null, allowed: string[] }

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
    const detail = problems.map(p =>
      `'${p.key}'${p.suggestion ? ` — did you mean '${p.suggestion}'?` : ''}`).join(', ')
    const valid = problems[0].allowed.join(', ')
    throw new BadRequest(
      `Unknown filter ${problems.length > 1 ? 'keys' : 'key'} ${detail}. ` +
      `Filterable fields on ${accessor}: ${valid}. ` +
      `Paging and sorting are directives, not filters — use $limit, $offset, $orderBy, $select.`,
      problems.map(p => ({ field: p.key, message: `Unknown filter key '${p.key}'` })),
    )
  }
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
  opaque:   ' (stores a serialisation — not sortable)',
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

  let perModel = _gateFor.get(c as object)
  if (!perModel) { perModel = new Map(); _gateFor.set(c as object, perModel) }
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

// ─── Session → gate level ─────────────────────────────────────────────────

/**
 * Litestone's access-level scale, mirrored.
 *
 * Deliberately a local copy rather than an import: `@frontierjs/litestone` is
 * an optional peer dependency here, and junction's own resolution of it is a
 * different build from the one an app passes in. These are wire values, fixed
 * by the @@gate grammar — see litestone's src/plugins/gate.js.
 */
export const LEVELS = {
  STRANGER:      0,
  VISITOR:       1,
  READER:        2,
  CREATOR:       3,
  USER:          4,
  ADMINISTRATOR: 5,
  OWNER:         6,
  SYSADMIN:      7,
  SYSTEM:        8,   // asSystem() only — never returned by a getLevel()
  LOCKED:        9,
} as const

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
 * Litestone owns the SCALE. Each caller owns the mapping from its own user
 * shape onto that scale, and Junction's shape is SessionContext.
 *
 * Litestone's own default, FrontierGateGetLevel, grades a different shape:
 * verifiedAt → activatedAt → role → isAdmin/isOwner/isSystemAdmin. A
 * SessionContext overlaps it on `role` alone, and `role` is tested third — so
 * a session with no verifiedAt graded as VISITOR (1) no matter what it
 * carried, and @@gate could not authorize a write for a *logged-in* user:
 *
 *   403  "Post.create" requires level 4, user has level 1
 *
 * returned after Junction's own gateAuth hook had already approved the
 * request. Two gates disagreeing about who the caller is.
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
 *   anything else that authenticated → USER        (4)
 *
 * Role strings are NOT interpreted. 'admin' means whatever an app decides it
 * means, and guessing would hand out level 5 on a string match. Apps that
 * grade by role wrap this:
 *
 *   getLevel: (u) => u?.role === 'staff' ? LEVELS.ADMINISTRATOR : sessionGateLevel(u)
 */
/**
 * What sessionGateLevel() actually reads.
 *
 * Structural on purpose. Typing the parameter as SessionContext would have been
 * the obvious choice and would not have composed: Litestone types GatePlugin's
 * getLevel as `(user: LitestoneAuth | null, model: string) => number`, so a
 * SessionContext-only signature is not assignable and every app would need a
 * cast at the one line this whole fix exists to make clean. This shape is a
 * supertype of both — SessionContext passes, LitestoneAuth passes.
 */
export interface GradableUser {
  verifiedAt?:    Date | string | null
  activatedAt?:   Date | string | null
  isAdmin?:       boolean
  isOwner?:       boolean
  isSystemAdmin?: boolean
}

export function sessionGateLevel(
  user?: GradableUser | null
): number {
  if (!user) return LEVELS.STRANGER

  // Explicit standing wins over the lifecycle: an owner who never completed
  // an activation step is still the owner.
  if (user.isSystemAdmin) return LEVELS.SYSADMIN
  if (user.isOwner)       return LEVELS.OWNER
  if (user.isAdmin)       return LEVELS.ADMINISTRATOR

  // `null` is the app saying "modelled, not reached". `undefined` is silence.
  if (user.verifiedAt  === null) return LEVELS.VISITOR
  if (user.activatedAt === null) return LEVELS.READER

  return LEVELS.USER
}

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

export function withLitestoneDb(db: unknown): import('./hooks.ts').AroundHook {
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
    await next()
  }
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

  // model name → service name, built on first use: services are registered
  // during the start phases and this installer runs before them.
  let index: Map<string, string> | null = null
  const warned = new Set<string>()

  const serviceFor = (model: string): string | undefined => {
    if (!index) {
      index = new Map()
      for (const name of app.services.list()) {
        const svc = app.services.get(name) as { model?: string } | undefined
        // `model:` when declared, otherwise the same singularisation every
        // other resolver uses (Invariant 2) — one owner, so a service named for
        // its URL resolves here exactly as it does for the gate and the filter.
        const m = svc?.model ?? singularize(name)
        index.set(m.toLowerCase(), name)
      }
    }
    return index.get(model.toLowerCase())
  }

  const sendToChannel = (name: string, event: string, payload: unknown): void => {
    const svc = app.services.get(name) as { channel?: unknown } | undefined
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
    const manager = app.channels as
      { channel?: (n: string) => { send?: (event: string, data: unknown) => void } } | undefined
    const ch = manager?.channel?.(decl)
    if (!ch?.send) return
    try { ch.send(`${name} ${event}`, payload) }
    catch { /* a dead socket is not a background job's problem */ }
  }

  return tap((e) => {
    const past = PAST[e.event as string]
    if (!past || !e.model) return              // 'transition' has its own event, not a CRUD one
    const name = serviceFor(e.model)
    if (!name) return
    // The write is already covered by callService's announcement point — but
    // only for the service that call is running. A write to ANOTHER model from
    // inside a hook (the audit row an orders hook writes) is not covered by
    // `orders created` and still announces under its own name.
    //
    // The comparison survives the emitter's setImmediate because ALS propagates
    // to a callback through the scheduling, so the store read here is the one
    // that was active at the write.
    if (announcingService() === name) return

    const row = e.result
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
      sendToChannel(name, 'changed', detail)
      return
    }

    app.events?.emit(`${name}:${past}`, row)
    sendToChannel(name, past, row)
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
}

declare module './context.ts' {
  interface ServiceContextLocals {
    /** The tenant this call is for, under `tenancy { strategy database }`. */
    tenantId?: string
  }
}

/**
 * around hook: put THIS tenant's client on `ctx.locals.db`.
 *
 * Installed by `createApp({ tenants })`. It replaces `withLitestoneDb` rather
 * than composing with it — an app has one `ctx.locals.db` and two hooks
 * assigning it is a race decided by hook order.
 */
export function withTenantDb(registry: TenantRegistryLike): import('./hooks.ts').AroundHook {
  return async function withTenantDb(ctx, next) {
    const principal = ctx.auth?.user ? toDataPrincipal(ctx.auth.user) : null
    const headers   = (ctx.client?.headers ?? {}) as Record<string, unknown>
    const host      = (headers.host ?? headers.Host ?? null) as string | null

    // A caller may STATE the tenant — `app.service('x').find({ locals: { tenantId } })`
    // — and that is the only way work with no request behind it can name one.
    // A job, a scheduled sweep and a webhook replay all arrive with no host, no
    // header and often no principal.
    const stated = ctx.locals.tenantId
    const id = stated ?? registry.tenantFor?.({ host, headers, principal }) ?? null

    if (!id) {
      const how = registry.tenancy?.resolve
      throw new BadRequest(
        `No tenant on this request. The schema resolves a tenant by ` +
        `${how ? describeResolution(how) : 'nothing — the tenancy block declares no `resolve`'}` +
        `${host ? `, and this request's Host is '${host}'` : ''}. ` +
        `Work with no request behind it names its tenant explicitly: ` +
        `app.service(name).method(…, { locals: { tenantId } }).`,
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

    ctx.locals.tenantId = id
    ctx.locals.db = principal && typeof client?.$setAuth === 'function'
      ? client.$setAuth(principal)
      : client

    await next()
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

  let per = _rowScoped.get(c as object)
  if (!per) { per = new Map(); _rowScoped.set(c as object, per) }
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
    // Reading an unknown property off a Litestone client THROWS, so the
    // capability probe is itself a throwing expression (see autoFilter).
    let tenancy: ResolvedTenancy | null | undefined
    try { tenancy = (db as { $tenancy?: ResolvedTenancy | null })?.$tenancy } catch { return }
    if (!tenancy || tenancy.strategy !== 'row' || !tenancy.claim) return

    const user = ctx.auth?.user
    if (!user) return

    const principal = toDataPrincipal(user) as Record<string, unknown>
    if (principal[tenancy.claim] != null) return

    if (!isRowScoped(db, ctx.service)) return

    throw new Unauthorized(
      `This session carries no '${tenancy.claim}', and '${ctx.service}' is scoped to it by the schema — ` +
      `every read would answer an empty list and every write would be refused. ` +
      `Put the column on the session (sessionFields in @frontierjs/auth), or mark the model @@tenant(none).`,
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

    // Absolute paths are correct and unreadable. Anything under the process
    // CWD prints relative to it — which is also where a logger `path` resolves
    // from, so the two agree.
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
    }
  } catch {
    return null           // not a Litestone client — say nothing rather than throw
  }
}
