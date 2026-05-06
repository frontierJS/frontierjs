// core/service.ts
// Service layer — the heart of the framework.
// createBaseService() exposes the 5 CRUD methods.
// createService() composes hooks + base + custom overrides.
// Services are registered in the app and called by the transport.

import type { ServiceContext, ServiceMethod } from '../transport/bridge.ts'
import {
  resolvePipelines,
  mergeHookMaps,
  runPipeline,
  type HookMap,
  type ResolvedPipeline
} from './hooks.ts'
import { NotFound, BadRequest, toFrameworkError } from './errors.ts'
import { createMemoryCache, type ICache }         from '../cache/index.ts'

// ─── Service-level cache ──────────────────────────────────────────────────
// Declared on createService({ cache: true | { ttl, keyBy } }).
// Hooks are injected automatically — no manual hook wiring required.

export type CacheDeclaration =
  | true
  | { ttl?: string; keyBy?: (ctx: ServiceContext) => string }

// Module-level shared cache instance — lazily created, shared across all
// services that declare cache:. All service keys are namespaced by service
// name so a bust on 'notes:' never touches 'users:'.
let _sharedCache: ICache | null = null

function getSharedCache(): ICache {
  if (!_sharedCache) _sharedCache = createMemoryCache({ defaultTtl: '30 seconds', maxSize: 1000 })
  return _sharedCache
}

/**
 * Replace the default shared cache (e.g. with a SQLite-backed one).
 * Call before app.start() — typically inside a configure() plugin.
 */
export function setServiceCache(cache: ICache): void {
  _sharedCache = cache
}

/**
 * Builds a deterministic, normalised cache key from a ServiceContext.
 *
 * find → `{service}:find:{sorted-params}[:uid={userId}]`
 * get  → `{service}:get:{id}[:uid={userId}]`
 *
 * Query params are key-sorted so param order never produces phantom misses.
 * User ID is appended when present — naturally scopes auth'd routes without
 * needing to inspect the hook pipeline.
 */
function buildCacheKey(ctx: ServiceContext): string {
  const userSeg = ctx.params.user?.userId != null ? `:uid=${ctx.params.user.userId}` : ''

  if (ctx.method === 'get') {
    return `${ctx.service}:get:${ctx.id ?? ''}${userSeg}`
  }

  const query  = ctx.query ?? {}
  const sorted = Object.keys(query)
    .sort()
    .map(k => `${k}=${JSON.stringify(query[k])}`)
    .join('&')

  return `${ctx.service}:find:${sorted}${userSeg}`
}

type HookFn = (ctx: ServiceContext) => Promise<void> | void

function buildCacheHooks(
  serviceName: string,
  decl: CacheDeclaration,
): { checkCache: HookFn; storeResult: HookFn; bustCache: HookFn } {
  const opts      = decl === true ? {} : decl
  const customKey = opts.keyBy
  const ttl       = (opts as { ttl?: string }).ttl

  const getKey = (ctx: ServiceContext) =>
    customKey ? customKey(ctx) : buildCacheKey(ctx)

  const checkCache: HookFn = (ctx) => {
    const hit = getSharedCache().get(getKey(ctx))
    if (hit !== undefined) ctx.result = hit
  }

  const storeResult: HookFn = (ctx) => {
    if (ctx.result !== null) {
      getSharedCache().set(getKey(ctx), ctx.result, ttl)
    }
  }

  const bustCache: HookFn = () => {
    getSharedCache().clear(`${serviceName}:`)
  }

  return { checkCache, storeResult, bustCache }
}



export interface Service {
  name:     string
  model?:   string   // model name — used in result envelope object field
  find:     (ctx: ServiceContext) => Promise<unknown>
  get:      (ctx: ServiceContext) => Promise<unknown>
  create:   (ctx: ServiceContext) => Promise<unknown>
  patch:    (ctx: ServiceContext) => Promise<unknown>
  remove:   (ctx: ServiceContext) => Promise<unknown>
  restore?: (ctx: ServiceContext) => Promise<unknown>

  // Hook registration — can be called multiple times, hooks accumulate
  hooks:    (map: HookMap) => void

  // ── Hook-bypass methods (à la Feathers _find/_get) ───────────────────────────────
  // Call the underlying method directly — no hook pipeline, no events, no cache.
  // Intentional escape hatch for:
  //   • Reading inside a before hook without re-triggering hooks
  //   • Job handlers that explicitly don’t want side-effects
  //   • Low-level seeding / migration scripts
  // If you want side-effects (publish, audit, cache-bust) use service() instead.
  _find:    (ctx: ServiceContext) => Promise<unknown>
  _get:     (ctx: ServiceContext) => Promise<unknown>
  _create:  (ctx: ServiceContext) => Promise<unknown>
  _patch:   (ctx: ServiceContext) => Promise<unknown>
  _remove:  (ctx: ServiceContext) => Promise<unknown>
  _restore: (ctx: ServiceContext) => Promise<unknown>

  // Internal
  _hookMap:   HookMap
  _pipelines: Record<string, ResolvedPipeline>
  // Pre-baked merge of app-level + service-level hooks. Set by app.start()
  // after all plugins have registered. Eliminates per-request mergeHookMaps().
  _compiledPipelines?: Record<string, ResolvedPipeline>

  // Custom methods — defined directly on the service alongside CRUD
  // e.g. createService({ name: 'servers', reboot: async (ctx) => { ... } })
  // Routed as POST /api/{service}/{id}/{method} or GET /api/{service}/{id}/{method}
  [method: string]: unknown
}

// ─── Service call entry point ─────────────────────────────────────────────
// Called by the transport after bridge.toContext()

// Minimal event emitter interface — avoids importing IEventBus here
interface EventEmitter { emit(event: string, data: unknown): void | Promise<void> }

// ─── Telemetry events ─────────────────────────────────────────────────────
// Emitted on app.telemetry by callService() and runPipeline().
// Correlate by telemetryId to build per-request profiles.

export interface CallStartEvent {
  telemetryId: string
  service:     string
  method:      string
  transport:   string
  userId:      string | null
  id:          string | number | null
}

export interface TelemetryEvent {
  telemetryId?: string               // undefined for bypass calls (_find etc.)
  service:      string
  method:       string
  transport:    string               // 'http' | 'websocket' | 'internal'
  userId:       string | null        // null for unauthenticated calls
  id:           string | number | null
  durationMs:   number
  status:       'ok' | 'error'
  error?:       { name: string; message: string; code: number }
}

export interface HookTelemetryEvent {
  telemetryId:  string | undefined
  service:      string
  method:       string
  phase:        'before' | 'after' | 'around' | 'error'
  hookName:     string               // fn.name or 'anonymous'
  index:        number               // position in hook array
  durationMs:   number
  status:       'ok' | 'error'
  error?:       { name: string; message: string }
}

// Auto-event names for the five CRUD methods
const AUTO_EVENT_MAP: Record<string, string> = {
  create:  'created',
  patch:   'patched',
  remove:  'removed',
  restore: 'restored',
}

const CRUD_METHODS = new Set(['find', 'get', 'create', 'patch', 'remove', 'restore'])

export async function callService(
  service:    Service,
  ctx:        ServiceContext,
  appHooks?:  HookMap,
  events?:    EventEmitter,
  telemetry?: EventEmitter
): Promise<void> {

  const start  = Date.now()
  const method = ctx.method
  const isAction = !CRUD_METHODS.has(method as string)

  // For custom methods, check the service has it registered
  if (isAction && typeof (service as Record<string, unknown>)[method as string] !== 'function') {
    throw new NotFound(`Method '${method}' not found on service '${service.name}'`)
  }

  // ── Telemetry: stamp correlation ID + emit start ───────────────────
  if (telemetry) {
    ctx.telemetryId = crypto.randomUUID()
    telemetry.emit('junction.call.start', {
      telemetryId: ctx.telemetryId,
      service:     service.name,
      method:      method as string,
      transport:   ctx.transport ?? 'internal',
      userId:      ctx.params.user?.userId ?? null,
      id:          ctx.id,
    } satisfies CallStartEvent)
  }

  // Use pre-baked pipelines from app.start() when available.
  // Falls back to per-request merge only if start() hasn't compiled yet
  // (e.g. direct callService usage in tests before app.start()).
  const pipeline = service._compiledPipelines?.[method as string]
    ?? (appHooks
      ? resolvePipelines(mergeHookMaps(appHooks, service._hookMap))[method as string]
      : service._pipelines[method as string])

  // Fall back to an empty pipeline if the action has no hooks configured
  const resolvedPipeline = pipeline ?? { around: [], before: [], after: [], error: [] }

  const methodFn = isAction
    ? (service as Record<string, unknown>)[method as string] as (ctx: ServiceContext) => Promise<unknown>
    : service[method as ServiceMethod]

  try {
    await runPipeline(ctx, resolvedPipeline, async () => {
      const raw = await methodFn(ctx)
      // Wrap raw result in ServiceResult envelope.
      // If the method already returned an envelope (e.g. cache hit), use as-is.
      if (raw !== null && raw !== undefined && typeof raw === 'object' && 'object' in (raw as object)) {
        ctx.result = raw as import('../transport/bridge.ts').ServiceResult
      } else {
        ctx.result = wrapResult(raw, service.model ?? service.name, method as string)
      }
    }, telemetry)
  } finally {
    // Run per-request cleanup callbacks (e.g. litestone $tapQuery stop)
    if (ctx._cleanups?.length) {
      for (const fn of ctx._cleanups) { try { fn() } catch {} }
      ctx._cleanups = []
    }
  }

  // ── Telemetry: emit end ────────────────────────────────────────────
  // Fired after every call — success or error. Never throws.
  // junction.call kept as alias for back-compat; junction.call.end is canonical.
  if (telemetry) {
    const event: TelemetryEvent = {
      telemetryId: ctx.telemetryId,
      service:     service.name,
      method:      method as string,
      transport:   ctx.transport ?? 'internal',
      userId:      ctx.params.user?.userId ?? null,
      id:          ctx.id,
      durationMs:  Date.now() - start,
      status:      ctx.error ? 'error' : 'ok',
      ...(ctx.error ? {
        error: {
          name:    ctx.error.name,
          message: ctx.error.message,
          code:    ctx.error.code,
        }
      } : {}),
    }
    telemetry.emit('junction.call.end', event)
    telemetry.emit('junction.call', event)   // back-compat alias
  }

  // ── Auto-events ───────────────────────────────────────────────────
  // After a successful create/patch/remove, emit a namespaced event so
  // any part of the app can react without explicit emit() calls in services.
  // Event format: '<service>:<past-tense-method>'
  //   notes:created, users:patched, deployments:removed
  //
  // Only fires when:
  //   • the call succeeded (no ctx.error)
  //   • the method is one of create/patch/remove (not find/get or custom methods)
  //   • an event emitter was passed (i.e. call came from the HTTP transport)
  if (!ctx.error && events && AUTO_EVENT_MAP[method as string]) {
    const eventName = `${service.name}:${AUTO_EVENT_MAP[method as string]}`
    events.emit(eventName, ctx.result)
  }
}

// ─── Base service — Litestone adapter ─────────────────────────────────────
// One per model. Litestone's db client is the actual implementation.

export interface BaseServiceOptions {
  model:     string           // Litestone model name e.g. 'user'
  db:        () => unknown    // getter — returns Litestone db client
  paginate?: {
    default: number
    max:     number
  }
  // Must be explicitly true to allow DELETE/PATCH without an id.
  // Protects against accidental whole-table wipes from a missing id param.
  allowBulk?: boolean
}

export function createBaseService(opts: BaseServiceOptions): Omit<Service, 'name' | '_pipelines' | 'hooks'> {

  const { model, db, paginate } = opts

  const getTable = () => {
    const client = db() as Record<string, Record<string, Function>>
    const table  = client[model]
    if (!table) throw new Error(`Litestone model '${model}' not found`)
    return table
  }

  return {

    async find(ctx: ServiceContext): Promise<unknown> {
      const table = getTable()

      const { $limit, $offset, $orderBy, $select, ...where } = ctx.query as Record<string, unknown>

      const take   = Math.min(
        Number($limit ?? paginate?.default ?? 20),
        paginate?.max ?? 100
      )
      const offset = Number($offset ?? 0)
      const query: Record<string, unknown> = { where, take, skip: offset }

      if ($orderBy)
        query.orderBy = parseSortParam($orderBy as string)

      if ($select)
        query.select = parseSelectParam($select as string)

      const [data, total] = await Promise.all([
        table.findMany(query),
        table.count({ where })
      ])

      return { total, limit: take, offset, data }
    },

    async get(ctx: ServiceContext): Promise<unknown> {
      const table = getTable()

      // get(id) → findUnique   |   get(query) → findFirst (no id, query present)
      if (ctx.id) {
        const record = await table.findUnique({ where: { id: ctx.id } })
        if (!record) throw new NotFound(`${model} ${ctx.id} not found`)
        return record
      }

      const where  = { ...ctx.query } as Record<string, unknown>
      const record = await table.findFirst({ where })
      if (!record) throw new NotFound(`${model} not found`)
      return record
    },

    async create(ctx: ServiceContext): Promise<unknown> {
      if (!ctx.data) throw new BadRequest('Data is required')

      const table = getTable()

      return table.create({ data: ctx.data })
    },

    async patch(ctx: ServiceContext): Promise<unknown> {
      if (!ctx.data) throw new BadRequest('Data is required')

      const table = getTable()

      // Patch by id or by query
      if (ctx.id) {
        return table.update({ where: { id: ctx.id }, data: ctx.data })
      }

      // Bulk patch — requires explicit opt-in to prevent accidental mass-updates
      if (!paginate && !opts.allowBulk) {
        throw new BadRequest(
          'Bulk patch requires allowBulk: true on the service definition. ' +
          'Pass an id to patch a single record.'
        )
      }

      const { $limit, $offset, ...where } = ctx.query as Record<string, unknown>
      return table.updateMany({ where, data: ctx.data })
    },

    async remove(ctx: ServiceContext): Promise<unknown> {
      const table = getTable()

      if (ctx.id) {
        return table.delete({ where: { id: ctx.id } })
      }

      // Bulk delete — requires explicit opt-in to prevent whole-table wipes
      if (!opts.allowBulk) {
        throw new BadRequest(
          'Bulk delete requires allowBulk: true on the service definition. ' +
          'Pass an id to delete a single record.'
        )
      }

      const { $limit, $offset, ...where } = ctx.query as Record<string, unknown>

      // Safety: refuse to delete everything if no where conditions remain
      if (Object.keys(where).length === 0) {
        throw new BadRequest(
          'Bulk delete with no filter conditions is not allowed. ' +
          'Provide at least one query parameter to scope the deletion.'
        )
      }

      return table.deleteMany({ where })
    }
  }
}

// ─── Service factory ──────────────────────────────────────────────────────
// Composes base + custom overrides + hooks into a full Service.

export interface ServiceDefinition {
  name:       string
  model?:     string
  db?:        () => unknown
  paginate?:  { default: number; max: number }
  allowBulk?: boolean

  /**
   * Enable response caching for read methods (find, get).
   * Writes (create, patch, remove) automatically bust all keys for this service.
   *
   * @example
   * cache: true                           // 30s TTL, auto auth-scoped
   * cache: { ttl: '2 minutes' }           // custom TTL (uses parseTtl format)
   * cache: { keyBy: (ctx) => ctx.id }     // fully custom key function
   */
  cache?: CacheDeclaration

  // CRUD method overrides
  find?:      (ctx: ServiceContext) => Promise<unknown>
  get?:       (ctx: ServiceContext) => Promise<unknown>
  create?:    (ctx: ServiceContext) => Promise<unknown>
  patch?:     (ctx: ServiceContext) => Promise<unknown>
  remove?:    (ctx: ServiceContext) => Promise<unknown>
  restore?:   (ctx: ServiceContext) => Promise<unknown>

  // Custom methods — defined directly alongside CRUD methods
  // e.g. { name: 'servers', reboot: async (ctx) => { ... } }
  // Hook config uses the method name as key: hooks: { before: { reboot: [...] } }
  [method: string]: unknown

  hooks?:     HookMap
}

// ── Bypass wrapper — emits lightweight telemetry for _find/_get etc. ───────
function makeBypass(
  serviceName: string,
  method:      string,
  fn:          (ctx: ServiceContext) => Promise<unknown>
): (ctx: ServiceContext) => Promise<unknown> {
  return async (ctx: ServiceContext) => {
    const start     = Date.now()
    const telemetry = (ctx.app as Record<string, unknown>)?.telemetry as EventEmitter | undefined
    try {
      return await fn(ctx)
    } finally {
      if (telemetry) {
        telemetry.emit('junction.call.end', {
          telemetryId: undefined,   // no pipeline correlation for bypass calls
          service:     serviceName,
          method,
          transport:   ctx.transport ?? 'internal',
          userId:      ctx.params?.user?.userId ?? null,
          id:          ctx.id,
          durationMs:  Date.now() - start,
          status:      ctx.error ? 'error' : 'ok',
        } satisfies TelemetryEvent)
      }
    }
  }
}

export function createService(def: ServiceDefinition): Service {

  const base = def.model && def.db
    ? createBaseService({ model: def.model, db: def.db, paginate: def.paginate, allowBulk: def.allowBulk })
    : notImplementedBase()

  const hookMaps: HookMap[] = []

  // ── Cache hook injection ──────────────────────────────────────────────────
  // Split into two pushes so ordering is correct:
  //   before pipeline: [checkCache, ...userBeforeHooks]  — short-circuits early
  //   after  pipeline: [...userAfterHooks, storeResult]  — stores final result
  //   after  pipeline: [...userAfterHooks, bustCache]    — busts after all transforms
  let cacheHooks: ReturnType<typeof buildCacheHooks> | null = null
  if (def.cache) {
    cacheHooks = buildCacheHooks(def.name, def.cache)
    // Push before-cache hooks FIRST — checkCache must run before user hooks
    hookMaps.push({
      before: {
        find: [cacheHooks.checkCache],
        get:  [cacheHooks.checkCache],
      },
    })
  }

  if (def.hooks) {
    // Dev-mode: warn on anonymous hooks — they show as 'anonymous' in telemetry waterfall
    if (process.env.NODE_ENV !== 'production' && def.hooks) {
      for (const phase of ['before', 'after', 'around', 'error'] as const) {
        const phaseHooks = def.hooks[phase]
        if (!phaseHooks) continue
        for (const [method, hooks] of Object.entries(phaseHooks)) {
          if (!Array.isArray(hooks)) continue
          for (const hook of hooks) {
            if (typeof hook === 'function' && !hook.name) {
              console.warn(
                `[Junction] anonymous hook on ${def.name}.${phase}.${method} — ` +
                `name your hooks for telemetry (e.g. assign to a named const or use a named function)`
              )
            }
          }
        }
      }
    }
    hookMaps.push(def.hooks)
  }

  if (cacheHooks) {
    // Push after-cache hooks LAST — storeResult sees the fully transformed result
    hookMaps.push({
      after: {
        find:   [cacheHooks.storeResult],
        get:    [cacheHooks.storeResult],
        create: [cacheHooks.bustCache],
        patch:  [cacheHooks.bustCache],
        remove: [cacheHooks.bustCache],
      },
    })
  }

  let mergedMap = mergeHookMaps(...hookMaps)
  let pipelines = resolvePipelines(mergedMap)

  const service: Service = {
    name:  def.name,
    model: def.model ?? def.name,

    find:    def.find    ?? base.find,
    get:     def.get     ?? base.get,
    create:  def.create  ?? base.create,
    patch:   def.patch   ?? base.patch,
    remove:  def.remove  ?? base.remove,
    restore: def.restore ?? base.restore,

    // ── Hook-bypass methods ────────────────────────────────────────────────────
    // Direct method access — skips the hook pipeline entirely.
    // Emits a lightweight junction.call.end on app.telemetry (no start, no hooks).
    _find:    makeBypass(def.name, 'find',    def.find    ?? base.find),
    _get:     makeBypass(def.name, 'get',     def.get     ?? base.get),
    _create:  makeBypass(def.name, 'create',  def.create  ?? base.create),
    _patch:   makeBypass(def.name, 'patch',   def.patch   ?? base.patch),
    _remove:  makeBypass(def.name, 'remove',  def.remove  ?? base.remove),
    _restore: makeBypass(def.name, 'restore', def.restore ?? base.restore),

    hooks(map: HookMap): void {
      hookMaps.push(map)
      mergedMap          = mergeHookMaps(...hookMaps)
      pipelines          = resolvePipelines(mergedMap)
      service._hookMap   = mergedMap
      service._pipelines = pipelines
    },

    _hookMap:   mergedMap,
    _pipelines: pipelines,
  }

  // Copy custom methods from def directly onto the service object
  // Anything that is a function and not a reserved key becomes a callable method
  const RESERVED_KEYS = new Set([
    'name', 'model', 'find', 'get', 'create', 'patch', 'remove', 'restore',
    '_find', '_get', '_create', '_patch', '_remove', '_restore',
    'hooks', 'paginate', 'allowBulk', 'cache', 'softDelete', 'idField', 'db',
  ])
  for (const [key, val] of Object.entries(def)) {
    if (!RESERVED_KEYS.has(key) && typeof val === 'function') {
      (service as Record<string, unknown>)[key] = val
    }
  }

  return service
}

// ─── Service registry ─────────────────────────────────────────────────────

export class ServiceRegistry {

  private _map:      Map<string, Service> = new Map()
  // Set by app.start() after all plugins have registered — used to
  // immediately compile pipelines for services registered late (e.g. inside
  // a plugin's boot() or ready() hook) so they never fall back to per-request
  // mergeHookMaps(). Also handles app.hooks() calls made after start().
  private _appHooks: HookMap | null = null

  // Called by app.start() once all plugins and app-level hooks are finalised.
  setAppHooks(hooks: HookMap): void {
    this._appHooks = hooks
    // Recompile pipelines for every already-registered service so that
    // calling setAppHooks() after services are registered (e.g. app.hooks()
    // after start()) doesn't leave stale compiled pipelines.
    this._recompileAll()
  }

  private _recompileAll(): void {
    if (!this._appHooks) return
    for (const svc of this._map.values()) {
      svc._compiledPipelines = resolvePipelines(
        mergeHookMaps(this._appHooks, svc._hookMap)
      )
    }
  }

  register(service: Service): void {
    this._map.set(service.name, service)
    // If app-level hooks are already known (registered after start()),
    // compile immediately so this service never hits the per-request fallback.
    if (this._appHooks) {
      service._compiledPipelines = resolvePipelines(
        mergeHookMaps(this._appHooks, service._hookMap)
      )
    }
  }

  get(name: string): Service | undefined {
    return this._map.get(name)
  }

  has(name: string): boolean {
    return this._map.has(name)
  }

  list(): string[] {
    return Array.from(this._map.keys())
  }

  /** Returns all registered Service objects — use list() for names only */
  values(): Service[] {
    return Array.from(this._map.values())
  }

  async call(name: string, ctx: ServiceContext, appHooks?: HookMap, events?: { emit(e: string, d: unknown): void }, telemetry?: { emit(e: string, d: unknown): void }): Promise<void> {
    const service = this._map.get(name)
    if (!service)
      throw new NotFound(`Service '${name}' not found`)
    await callService(service, ctx, appHooks, events, telemetry)
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function notImplementedBase() {
  const err = () => { throw new Error('No model/db configured for this service') }
  return { find: err, get: err, create: err, patch: err, remove: err, restore: undefined }
}

// ─── Result envelope builder ──────────────────────────────────────────────
// Wraps raw service output in the consistent ServiceResult shape.
// find/paginated → { object: 'list', data: [...], total, limit, offset, errors: [] }
// bulk remove    → { object: 'list', data: id[], errors: [] }
// single         → { object: modelName, data: record, errors: [] }

function wrapResult(
  raw:    unknown,
  model:  string,
  method: string
): import('../transport/bridge.ts').ServiceResult {
  // Paginated find — { total, limit, offset, data: [...] }
  if (
    raw !== null &&
    typeof raw === 'object' &&
    'data' in (raw as object) &&
    'total' in (raw as object)
  ) {
    const p = raw as { total: number; limit: number; offset: number; data: unknown[] }
    return { object: 'list', data: p.data, errors: [], total: p.total, limit: p.limit, offset: p.offset }
  }

  // Array result — bulk patch T[], bulk remove id[], find without pagination
  if (Array.isArray(raw)) {
    return { object: 'list', data: raw, errors: [] }
  }

  // Single record
  return { object: model, data: raw, errors: [] }
}

// '$sort=name,-created_at' → { name: 'asc', created_at: 'desc' }
function parseSortParam(sort: string): Record<string, 'asc' | 'desc'> {
  const result: Record<string, 'asc' | 'desc'> = {}
  for (const field of sort.split(',')) {
    const f = field.trim()
    if (f.startsWith('-'))
      result[f.slice(1)] = 'desc'
    else
      result[f] = 'asc'
  }
  return result
}

// '$select=id,name,email' → { id: true, name: true, email: true }
function parseSelectParam(select: string): Record<string, boolean> {
  const result: Record<string, boolean> = {}
  for (const field of select.split(','))
    result[field.trim()] = true
  return result
}
