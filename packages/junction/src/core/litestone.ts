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
import { createService } from './service.ts'
import type { CacheDeclaration } from './service.ts'
import type { HookMap } from './hooks.ts'
import { NotFound, BadRequest } from './errors.ts'
import type { ServiceContext } from '../transport/bridge.ts'

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

export function parseQuery(
  query: Record<string, unknown>,
  defaultLimit = 20,
  maxLimit = 100
): ParsedQuery {
  const { $limit, $offset, $orderBy, $select, $populate,
          $search, $withDeleted, $onlyDeleted, ...where } = query

  const limit = Math.min(Number($limit ?? defaultLimit), maxLimit)

  return {
    where:        parseWhere(where),
    orderBy:      $orderBy      ? parseSort($orderBy as SortParam) : undefined,
    offset:       $offset       ? Number($offset) : 0,
    limit,
    select:       $select       ? parseSelect($select as SelectParam) : undefined,
    include:      $populate     ? parsePopulate($populate as PopulateParam) : undefined,
    search:       typeof $search === 'string' ? $search : undefined,
    withDeleted:  $withDeleted  === true || $withDeleted === 'true' || undefined,
    onlyDeleted:  $onlyDeleted  === true || $onlyDeleted === 'true' || undefined,
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

export interface LitestoneServiceOptions {
  model:       string
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
    const baseDb = ctx.params.db as LitestoneClient | undefined

    if (!baseDb) {
      throw new Error(
        `No Litestone db client on ctx.params.db — ` +
        `ensure withLitestoneDb is in your app around hooks`
      )
    }

    const SCOPED_KEY = '__litestoneScopedDb'
    if (!ctx.params[SCOPED_KEY]) {
      const scopedDb: LitestoneClient = ctx.params.user
        ? baseDb.$setAuth(ctx.params.user)
        : baseDb

      const telemetry = (ctx.app as Record<string, unknown>)?.telemetry as
        | { emit: (e: string, d: unknown) => void }
        | undefined

      if (telemetry && ctx.telemetryId) {
        const stop = scopedDb.$tapQuery((event: LitestoneQueryEvent) => {
          telemetry.emit('litestone.query', {
            ...event,
            telemetryId: ctx.telemetryId,
            isSystem:    !ctx.params.user,
          })
        })

        if (!ctx._cleanups) ctx._cleanups = []
        ctx._cleanups.push(stop)
      }

      ctx.params[SCOPED_KEY] = scopedDb
    }

    const scopedDb = ctx.params[SCOPED_KEY] as LitestoneClient
    const table    = scopedDb[model] as LitestoneTable | undefined

    if (!table) {
      throw new Error(
        `Litestone model '${model}' not found on db client — ` +
        `check your schema and model name`
      )
    }

    return table
  }

  async function restoreImpl(ctx: ServiceContext): Promise<unknown> {
    const table = getTable(ctx)
    const q     = parseQuery(ctx.query, paginate.default, paginate.max)

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
      const q     = parseQuery(ctx.query, paginate.default, paginate.max)
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
      const q     = parseQuery(ctx.query, 1, 1)

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

      const table = getTable(ctx)
      const q     = parseQuery(ctx.query, 1, 1)

      if (Array.isArray(ctx.data)) {
        ensureBulkAllowed('create')
        return table.createMany({ data: ctx.data })
      }

      const args: Record<string, unknown> = { data: ctx.data }
      if (q.select)  args.select  = q.select
      if (q.include) args.include = q.include

      return table.create(args)
    },

    async patch(ctx: ServiceContext): Promise<unknown> {
      if (!ctx.data) throw new BadRequest('Request body is required')

      const table = getTable(ctx)
      const q     = parseQuery(ctx.query, paginate.default, paginate.max)

      if (softDelete && (ctx.data as Record<string, unknown>)[softDelete] !== undefined) {
        throw new BadRequest(`Cannot set ${softDelete} directly — use remove()`)
      }

      if (ctx.id) {
        const where = { [idField]: ctx.id, ...softDeleteFilter() }
        const exists = await table.findUnique({ where })
        if (!exists) throw new NotFound(`${model} with ${idField}=${ctx.id} not found`)

        const args: Record<string, unknown> = { where, data: ctx.data }
        if (q.select)  args.select  = q.select
        if (q.include) args.include = q.include
        return table.update(args)
      }

      ensureBulkAllowed('patch')
      const where = { ...q.where, ...softDeleteFilter() }
      return table.updateMany({ where, data: ctx.data })
    },

    async remove(ctx: ServiceContext): Promise<unknown> {
      const table = getTable(ctx)
      const q     = parseQuery(ctx.query, paginate.default, paginate.max)

      if (ctx.id) {
        const where  = { [idField]: ctx.id, ...softDeleteFilter() }
        const record = await table.findUnique({ where })
        if (!record) throw new NotFound(`${model} with ${idField}=${ctx.id} not found`)

        if (softDelete) {
          return table.update({
            where,
            data: { [softDelete]: new Date().toISOString() },
          })
        }

        return table.remove({ where })
      }

      ensureBulkAllowed('remove')
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

export function withLitestoneDb(db: unknown): import('./hooks.ts').AroundHook {
  return async (ctx, next) => {
    ctx.params.db = db
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

export interface LitestoneServiceConfig {
  name:        string
  model?:      string
  schema?:     LitestoneJsonSchema
  idField?:    string
  paginate?:   { default: number; max: number }
  softDelete?: string
  allowBulk?:  boolean
  cache?:      CacheDeclaration
  hooks?:      HookMap
  [method: string]: unknown
}

const LITESTONE_RESERVED = new Set([
  'name', 'model', 'schema', 'idField', 'paginate',
  'softDelete', 'allowBulk', 'cache', 'hooks',
])

export function createLitestoneService(
  opts: LitestoneServiceConfig
): import('./service.ts').Service {
  const modelName = opts.model ?? deriveModelName(opts.name)

  const base = createLitestoneBase({
    model:      modelName,
    idField:    opts.idField,
    paginate:   opts.paginate,
    softDelete: opts.softDelete,
    allowBulk:  opts.allowBulk,
  })

  let autoHooks: HookMap | null = null
  let litestoneSchemas: {
    create: import('./schema.ts').CompiledSchema
    patch:  import('./schema.ts').CompiledSchema
  } | null = null

  if (opts.schema) {
    const defsKey = opts.schema.$defs[opts.name]
      ? opts.name
      : opts.schema.$defs[modelName]
        ? modelName
        : opts.schema.$defs[opts.name + 's']
          ? opts.name + 's'
          : opts.name

    try {
      const createJSchema = jsonSchemaToJunctionSchema(defsKey, opts.schema, 'create')
      const updateJSchema = jsonSchemaToJunctionSchema(defsKey, opts.schema, 'update')

      const createCompiled = createSchema(createJSchema)
      const updateCompiled = createSchema(updateJSchema)

      autoHooks = {
        before: {
          create: [createCompiled.hook()],
          patch:  [updateCompiled.hook()],
        },
      }

      litestoneSchemas = { create: createCompiled, patch: updateCompiled }
    } catch {
      console.warn(
        `[Junction] createLitestoneService: could not find schema for ` +
        `'${opts.name}' in $defs — skipping auto-validation`
      )
    }
  }

  const mergedHooks: HookMap | undefined =
    autoHooks && opts.hooks
      ? {
          before: {
            ...opts.hooks.before,
            create: [
              ...(opts.hooks.before?.create ?? []),
              ...(autoHooks.before?.create ?? []),
            ],
            patch: [
              ...(opts.hooks.before?.patch ?? []),
              ...(autoHooks.before?.patch ?? []),
            ],
          },
          after:  opts.hooks.after,
          around: opts.hooks.around,
          error:  opts.hooks.error,
        }
      : autoHooks ?? opts.hooks

  const customMethods: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(opts)) {
    if (!LITESTONE_RESERVED.has(key) && typeof val === 'function') {
      customMethods[key] = val
    }
  }

  const svc = createService({
    name:      opts.name,
    hooks:     mergedHooks,
    cache:     opts.cache,
    allowBulk: opts.allowBulk,
    ...base,
    ...customMethods,
  })

  if (litestoneSchemas) {
    ;(svc as Record<string, unknown>)._schemas = litestoneSchemas
  }

  ;(svc as Record<string, unknown>)._meta = {
    softDelete: opts.softDelete ?? null,
    cache:      !!opts.cache,
    idField:    opts.idField ?? 'id',
  }

  return svc
}
