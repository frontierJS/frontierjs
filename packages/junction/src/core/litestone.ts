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
//     function. We register a tap once per request (cached on ctx.params),
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
import { toBulkFailure, partitionBulk, BULK_FAILURES, type BulkFailure } from './envelope.ts'

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
  restoreMany:      (args:  Record<string, unknown>) => Promise<{ count: number }>
  search:           (query: string, args?: Record<string, unknown>) => Promise<{ rows: unknown[]; total: number }>  // @@fts models only
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
  search?:       string    // $search — FTS5 via table.search()
  withDeleted?:  boolean   // $withDeleted — include soft-deleted rows
  onlyDeleted?:  boolean   // $onlyDeleted — show only soft-deleted rows
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
          $search, $withDeleted, $onlyDeleted, ...where } = query

  const limitRaw   = directives.limit       ?? $limit
  const offsetRaw  = directives.offset      ?? $offset
  const orderByRaw = directives.orderBy     ?? $orderBy
  const selectRaw  = directives.select      ?? $select
  const popRaw     = directives.populate    ?? $populate
  const searchRaw  = directives.search      ?? $search
  const withDel    = directives.withDeleted ?? $withDeleted
  const onlyDel    = directives.onlyDeleted ?? $onlyDeleted

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
    withDeleted:  withDel === true || withDel === 'true' || undefined,
    onlyDeleted:  onlyDel === true || onlyDel === 'true' || undefined,
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

type SortParam = string | Record<string, number | string> | Record<string, string>[]

function parseSort(sort: SortParam): Record<string, 'asc' | 'desc'>[] {
  if (typeof sort === 'string') {
    return sort.split(',').map((field) => {
      const f = field.trim()
      if (f.startsWith('-')) return { [f.slice(1)]: 'desc' }
      return { [f]: 'asc' }
    })
  }
  if (Array.isArray(sort)) return sort as Record<string, 'asc' | 'desc'>[]
  return Object.entries(sort).map(([field, dir]) => ({
    [field]: (dir === 1 || dir === 'asc') ? 'asc' : 'desc',
  }))
}

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

export function deriveModelName(name: string): string {
  const clean = name.replace(/Service$/i, '')
  const camel = clean.charAt(0).toLowerCase() + clean.slice(1)

  if (camel.endsWith('ies')) return camel.slice(0, -3) + 'y'
  if (camel.endsWith('ses')) return camel.slice(0, -2)
  if (
    camel.endsWith('s') &&
    !camel.endsWith('ss') &&
    !camel.endsWith('us') &&
    !camel.endsWith('is') &&
    !camel.endsWith('as')
  ) {
    return camel.slice(0, -1)
  }

  return camel
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
}

export function createLitestoneBase(opts: LitestoneServiceOptions) {
  const {
    model,
    idField    = 'id',
    paginate   = { default: 20, max: 100 },
    softDelete,
    allowBulk  = true,
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
        ? baseDb.$setAuth(ctx.auth.user)
        : baseDb

      const telemetry = (ctx.app as Record<string, unknown>)?.telemetry as
        | { emit: (e: string, d: unknown) => void }
        | undefined

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
    // Enumerating is best-effort ON PURPOSE. A real Litestone client is a
    // Proxy whose ownKeys trap can return duplicate names, which makes
    // Object.keys() throw `TypeError: Proxy handler's 'ownKeys' trap result
    // must not contain any duplicate names`. Letting that escape would replace
    // this diagnostic with a stack trace about proxy internals — at exactly
    // the moment the caller needs to be told their model name is wrong.
    let available: string[] = []
    try {
      available = Object.keys(scopedDb)
        .filter(k => !k.startsWith('$') && k !== 'constructor')
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
    return table.restoreMany({ where: q.where })
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

  return {
    async find(ctx: ServiceContext): Promise<unknown> {
      const table = getTable(ctx)
      const q     = parseQuery(ctx.query, paginate.default, paginate.max, ctx.directives)
      const where = { ...q.where, ...softDeleteFilter() }

      // FTS5 search path — routes to table.search() when $search is present.
      // Only works on models with @@fts; Litestone throws a clear error otherwise.
      // Response is normalized to the same { total, limit, offset, data } envelope.
      if (q.search) {
        const args: Record<string, unknown> = {
          where,
          limit:  q.limit,
          offset: q.offset,
        }
        if (q.orderBy) args.orderBy = q.orderBy
        if (q.select)  args.select  = q.select
        if (q.include) args.include = q.include
        const { rows, total } = await table.search(q.search, args)
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
      if (q.withDeleted) args.withDeleted = true
      if (q.onlyDeleted) args.onlyDeleted = true

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
        if (q.withDeleted) args.withDeleted = true
        if (q.onlyDeleted) args.onlyDeleted = true

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
      if (q.withDeleted) args.withDeleted  = true
      if (q.onlyDeleted) args.onlyDeleted  = true

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
      const where = { ...q.where, ...softDeleteFilter() }
      return table.updateMany({ where, data: ctx.data })
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
        return table.updateMany({
          where,
          data: { [softDelete]: new Date().toISOString() },
        })
      }

      return table.removeMany({ where })
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
      const mod = await import('@frontierjs/litestone') as {
        generateJsonSchema?: (schema: unknown) => LitestoneJsonSchema
      }
      if (mod.generateJsonSchema) return mod.generateJsonSchema(c.$schema)
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
  return null
}

const _compiledFor = new WeakMap<object, Map<string, {
  create: import('./schema.ts').CompiledSchema
  patch:  import('./schema.ts').CompiledSchema
} | null>>()

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
      } else {
        try {
          // jsonSchemaToJunctionSchema returns a spec; createSchema compiles it.
          perModel.set(accessor, {
            create: createSchema(jsonSchemaToJunctionSchema(defsKey, jsonSchema, 'create')),
            patch:  createSchema(jsonSchemaToJunctionSchema(defsKey, jsonSchema, 'update')),
          })
        } catch {
          perModel.set(accessor, null)
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
        ? client.$setAuth(ctx.auth.user)
        : client
    await next()
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
    schema[field] = mapProp(prop, field, required, fullSchema.$defs)
  }

  return schema
}

function mapProp(
  prop:     LiJsonProp,
  field:    string,
  required: string[],
  defs:     Record<string, LitestoneModelDef | LitestoneEnumDef | LitestoneTypeDef | LitestoneFileDef>
): FieldDef {
  if (Array.isArray(prop.type)) {
    const nonNullType = prop.type.find((t) => t !== 'null')
    const synth: LiJsonProp = { ...prop, type: nonNullType }
    const def = mapProp(synth, field, required, defs)
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

