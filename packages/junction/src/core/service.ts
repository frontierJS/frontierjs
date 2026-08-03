// core/service.ts
// Service layer — the heart of the framework.
// createBaseService() exposes the 5 CRUD methods.
// createService() composes hooks + base + custom overrides.
// Services are registered in the app and called by the transport.

import type { ServiceContext, ServiceMethod } from './context.ts'
import {
  resolvePipelines,
  mergeHookMaps,
  runPipeline,
  type HookMap,
  type ResolvedPipeline
} from './hooks.ts'
import { NotFound, BadRequest, toFrameworkError } from './errors.ts'
import { createMemoryCache, type ICache }         from '../cache/index.ts'
import { wrapResult, isServiceResult, resultData } from './envelope.ts'
// NOTE: service.ts ⇄ litestone.ts is an intentional, safe ESM cycle:
// litestone imports createService (used only inside functions) and this
// module imports createLitestoneBase (used only inside createBaseService).
import { createSchema } from './schema.ts'
import {
  createLitestoneBase, autoValidate, gateAuth,
  jsonSchemaToJunctionSchema, resolveDefsKey,
} from './litestone.ts'

// ─── Service-level cache ──────────────────────────────────────────────────
// Declared on createService({ cache: true | { ttl, keyBy } }).
// Hooks are injected automatically — no manual hook wiring required.

export type CacheDeclaration =
  | true
  | { ttl?: string; keyBy?: (ctx: ServiceContext) => string }

// Service cache resolution, in precedence order:
//   1. setServiceCache() override — process-global, back-compat API for
//      swapping in e.g. a SQLite-backed cache.
//   2. Per-APP cache, lazily created and stored on ctx.app — each
//      createApp() instance gets its own, and app.stop() destroys it
//      (entries + GC timer). Previously a single module-level cache was
//      shared by every app in the process and outlived all of them.
//   3. Module-level fallback for bare callService() usage with no app
//      (direct pipeline tests).
// Kept as two separate slots: the explicit override must take precedence
// over per-app caches, but the lazily-created fallback must NOT — otherwise
// the first bare callService() in a process would permanently shadow every
// app's own cache.
let _overrideCache: ICache | null = null   // set via setServiceCache()
let _fallbackCache: ICache | null = null   // lazy, for app-less contexts only

const DEFAULT_CACHE_OPTS = { defaultTtl: '30 seconds', maxSize: 1000 }

function resolveCache(ctx: ServiceContext): ICache {
  if (_overrideCache) return _overrideCache

  // Only treat ctx.app as a cache host when it's a REAL app (has a service
  // registry) — bridge.internal() stubs ctx.app with a fresh {} when no app
  // is passed (bare callService in tests), and hanging a cache off each
  // throwaway stub would mean a new empty cache per call (never a hit).
  const app = ctx.app as { _serviceCache?: ICache; services?: unknown } | undefined | null
  if (app && typeof app === 'object' && app.services !== undefined) {
    if (!app._serviceCache) app._serviceCache = createMemoryCache(DEFAULT_CACHE_OPTS)
    return app._serviceCache
  }

  if (!_fallbackCache) _fallbackCache = createMemoryCache(DEFAULT_CACHE_OPTS)
  return _fallbackCache
}

/**
 * Replace the default shared cache (e.g. with a SQLite-backed one).
 * Call before app.start() — typically inside a configure() plugin.
 * NOTE: this is a process-global override that takes precedence over the
 * per-app cache; prefer it only when one process runs one app.
 */
export function setServiceCache(cache: ICache): void {
  _overrideCache = cache
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
  const userSeg = ctx.auth.user?.userId != null ? `:uid=${ctx.auth.user.userId}` : ''

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

  // Results are cloned on BOTH store and read. The cache must never hand out
  // a live reference: after-hooks (protect(), custom shapers) mutate ctx.result
  // in place, and a shared reference would let them corrupt the cached copy —
  // or worse, let a copy cached before protect() ran serve unstripped fields
  // (e.g. password hashes) to later callers.
  const checkCache: HookFn = (ctx) => {
    const hit = resolveCache(ctx).get(getKey(ctx))
    if (hit !== undefined) ctx.result = structuredClone(hit)
  }

  const storeResult: HookFn = (ctx) => {
    if (ctx.result !== null) {
      resolveCache(ctx).set(getKey(ctx), structuredClone(ctx.result), ttl)
    }
  }

  const bustCache: HookFn = (ctx) => {
    resolveCache(ctx).clear(`${serviceName}:`)
  }

  return { checkCache, storeResult, bustCache }
}



/**
 * Where a service's mutations are broadcast — the value of `channel:`.
 *
 * Named `channel` and not `publish`: 'publish' is a perfectly ordinary ACTION
 * name (publish a draft), and reserving it as an option key would stop a
 * service from having one. A noun cannot collide with a verb-shaped action.
 *
 *   'posts'        a channel name — the common case
 *   (rows, ctx) => a channel, an array of channels, or null to skip this one
 *   false          declared opt-out (documents intent; same effect as omitting)
 *
 * Omitted means no broadcast. See publishToChannels() for why the default is
 * off rather than on.
 */
export type PublishDeclaration =
  | string
  | false
  | ((data: unknown, ctx: ServiceContext) => unknown)

export interface Service {
  name:     string
  model?:   string   // model name — used in result envelope object field
  /** Channel(s) to broadcast mutations to. Omitted = no broadcast. */
  channel?: PublishDeclaration
  /**
   * Whether bulk (query-targeted, id-less) writes are permitted.
   *
   * Carried onto the built service so consumers can read it back. It was
   * declared on ServiceDefinition and honoured internally, but never landed
   * on the service object — so `/metrics` reported `allowBulk: false` for
   * every service, including ones configured `allowBulk: true`.
   */
  allowBulk?: boolean
  find:     (ctx: ServiceContext) => Promise<unknown>
  get:      (ctx: ServiceContext) => Promise<unknown>
  create:   (ctx: ServiceContext) => Promise<unknown>
  update:   (ctx: ServiceContext) => Promise<unknown>
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
  _update:  (ctx: ServiceContext) => Promise<unknown>
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
  // Routed as POST {apiPrefix}/{service}/{id}/{method} or GET {apiPrefix}/{service}/{id}/{method}
  [method: string]: unknown
}

// ─── Service call entry point ─────────────────────────────────────────────
// Called by the transport after bridge.toContext()

// Minimal event emitter interface — avoids importing IEventBus here
interface EventEmitter {
  emit(event: string, data: unknown): void | Promise<void>
  hasListeners?(event?: string): boolean
}

// Telemetry fast path: app.telemetry always exists, but most apps never
// subscribe to it. When the emitter can report listener counts and reports
// none, skip the per-call UUID + event-object allocations entirely.
// Emitters without hasListeners() (custom test doubles) keep full emits.
function telemetryEnabled(t?: EventEmitter): boolean {
  if (!t) return false
  return typeof t.hasListeners === 'function' ? t.hasListeners() : true
}

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

// Auto-event names for the CRUD write methods.
//
// Exported because the channel publisher must agree with it. It didn't: this
// map produced 'posts:created' on app.events while publish() derived its own
// name straight from ctx.method and put 'posts create' on the wire. The browser
// client listens for the past-tense form, so every WS consumer was matching
// names the server never sent. One map, both emitters.
export const AUTO_EVENT_MAP: Record<string, string> = {
  create:  'created',
  update:  'updated',
  patch:   'patched',
  remove:  'removed',
  restore: 'restored',
}

const CRUD_METHODS = new Set(['find', 'get', 'create', 'update', 'patch', 'remove', 'restore'])

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
  // Skipped entirely (no UUID, no allocations) when nothing subscribes.
  const t = telemetryEnabled(telemetry) ? telemetry : undefined
  if (t) {
    ctx.telemetryId = crypto.randomUUID()
    t.emit('junction.call.start', {
      telemetryId: ctx.telemetryId,
      service:     service.name,
      method:      method as string,
      transport:   ctx.transport ?? 'internal',
      userId:      ctx.auth.user?.userId ?? null,
      id:          ctx.id,
    } satisfies CallStartEvent)
  }

  // Use pre-baked pipelines from app.start() when available.
  // Falls back to per-request merge only if start() hasn't compiled yet
  // (e.g. direct callService usage in tests before app.start()).
  const pipelineSource = service._compiledPipelines
    ?? (appHooks
      ? resolvePipelines(mergeHookMaps(appHooks, service._hookMap))
      : service._pipelines)

  // Hook-less custom actions fall back to the '*' pipeline (app/service
  // 'all' hooks only) — never to an empty one, which would silently skip
  // Litestone scoping and every other app-level hook.
  const resolvedPipeline = pipelineSource[method as string]
    ?? pipelineSource['*']
    ?? { around: [], before: [], after: [], error: [] }

  const methodFn = (isAction
    ? (service as Record<string, unknown>)[method as string]
    : service[method as ServiceMethod]) as (ctx: ServiceContext) => Promise<unknown>

  let pipelineError: unknown = null

  try {
    await runPipeline(ctx, resolvedPipeline, async () => {
      const raw = await methodFn(ctx)
      // - null/undefined     → null (transport returns 204)
      // - already an envelope → as-is (cache hit, hook-set result)
      // - anything else       → wrap
      //
      // The passthrough test was `'object' in raw`, which is true of any record
      // with a column called `object` — such a row was mistaken for an envelope
      // and its (nonexistent) .data served instead. isServiceResult() checks
      // the `kind` discriminant.
      if (raw === null || raw === undefined) {
        ctx.result = null
      } else if (isServiceResult(raw)) {
        ctx.result = raw
      } else {
        // `object` names the SERVICE, so a client can key a cache or a type off
        // it without first working out which kind it is holding.
        ctx.result = wrapResult(raw, service.name)
      }
    }, t)   // gated: undefined when no telemetry subscribers → per-hook fast path
  } catch (err) {
    pipelineError = err
  } finally {
    // Run per-request cleanup callbacks (e.g. litestone $tapQuery stop)
    if (ctx._cleanups?.length) {
      for (const fn of ctx._cleanups) { try { fn() } catch {} }
      ctx._cleanups = []
    }
  }

  // ── Telemetry: emit end ────────────────────────────────────────────
  // Fired after every call — success or error. MUST emit even on throw so
  // observability tools see failed calls. (Was outside try/finally before;
  // a thrown pipeline would skip the emit entirely.)
  if (t) {
    const event: TelemetryEvent = {
      telemetryId: ctx.telemetryId,
      service:     service.name,
      method:      method as string,
      transport:   ctx.transport ?? 'internal',
      userId:      ctx.auth.user?.userId ?? null,
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
    t.emit('junction.call.end', event)
    t.emit('junction.call', event)   // back-compat alias
  }

  // ── Real-time: ONE origin ─────────────────────────────────────────
  // Every mutation announcement is decided here, once, and fans out to both
  // consumers: the in-process bus (server-side reactions) and the channel
  // manager (browsers).
  //
  // They used to be independent. callService emitted 'posts:created' on
  // app.events while a separately-wired publish() after-hook put
  // 'posts created' on the wire, which meant:
  //   • two places derived the event name, and they disagreed (fixed earlier)
  //   • ctx.dispatch = false suppressed the socket but not the bus
  //   • an app that forgot the hook had a silent half of its real-time layer
  //
  // Fires when the call succeeded and the method is a write. Reads never
  // announce — which is why this is per-method and not an `all` hook.
  if (!ctx.error && !pipelineError && AUTO_EVENT_MAP[method as string]) {
    const past = AUTO_EVENT_MAP[method as string]!

    // ctx.dispatch is the ONE suppression/override switch, honoured by both
    // consumers: `false` announces nothing, any other value replaces the
    // payload (redaction, shaping). Previously only the socket obeyed it, so
    // a hook that suppressed a broadcast still leaked the record to every
    // server-side subscriber — including the webhook fan-out.
    if (ctx.dispatch !== false) {
      const payload = ctx.dispatch !== undefined ? ctx.dispatch : resultData(ctx.result)

      // A bulk write announces once PER RECORD, as Feathers does. One event
      // carrying an array would reach a client store as a single malformed
      // upsert — the browser's created/patched/removed handlers each take one
      // record. Bulk create only started working recently, so this path is
      // newly reachable.
      const rows = Array.isArray(payload) ? payload : [payload]

      for (const row of rows) {
        events?.emit(`${service.name}:${past}`, row)
        await publishToChannels(service, ctx, `${service.name} ${past}`, row)
      }
    }
  }

  // Re-throw any pipeline error AFTER telemetry / cleanups have run.
  if (pipelineError) throw pipelineError
}

// ─── Base service — Litestone adapter ─────────────────────────────────────
// One per model. Litestone's db client is the actual implementation.

export interface BaseServiceOptions {
  /**
   * Litestone accessor — `'user'` for `model User`.
   *
   * OPTIONAL. Omitted, it resolves at call time from the service name, which
   * the autoloader derives from the filename. A plural spelling resolves too,
   * so all three of these reach `model Post`:
   *
   *   createBaseService({})                  // via 'posts' (the filename)
   *   createBaseService({ model: 'posts' })  // plural
   *   createBaseService({ model: 'post' })   // the accessor itself
   *
   * The literal spelling is always tried first, so an `@@external` model
   * mirroring a genuinely-plural foreign table still resolves to itself.
   */
  model?:    string

  /**
   * Service name. Optional — the autoloader derives it from the filename
   * ('leads.service.ts' → 'leads'), so it's only needed for services
   * registered by hand.
   */
  name?:     string

  /** Channel(s) to broadcast mutations to. See ServiceDefinition.channel. */
  channel?:  PublishDeclaration

  /**
   * Hook pipeline. Carried through onto the returned object.
   *
   * This used to be dropped: createBaseService destructured only
   * { model, db, paginate, allowBulk } and returned the bare CRUD methods, so
   * the natural shape
   *
   *   export default createBaseService({
   *     name:  'leads',
   *     model: 'lead',
   *     hooks: { before: { create: [authenticate] } },
   *   })
   *
   * type-checked, registered, and ran with no hooks at all. For `authenticate`
   * that is a silent authorization hole. Only the spread form worked:
   *
   *   export default { ...createBaseService({ model: 'lead' }), hooks: {...} }
   *
   * Both forms work now.
   */
  hooks?:    HookMap
  /**
   * Getter returning the db client. OPTIONAL — when omitted, the base
   * resolves the client at call time, in order:
   *   1. ctx.locals.db  — request-scoped client (withLitestoneDb)
   *   2. ctx.app.db     — the app's database
   * so the minimal service file is just createBaseService({ model: 'posts' }).
   */
  db?:       () => unknown
  paginate?: {
    default: number
    max:     number
  }
  // Must be explicitly true to allow DELETE/PATCH without an id.
  // Protects against accidental whole-table wipes from a missing id param.
  allowBulk?: boolean

  /**
   * Primary key field. Default 'id'.
   */
  idField?:  string

  /**
   * Soft-delete column override.
   *
   * Not usually needed: a Litestone model declaring `@@softDelete` is handled
   * by the runtime, which filters deleted rows and makes remove() stamp rather
   * than delete. This is the escape hatch for models whose schema does not
   * declare it.
   */
  softDelete?: string

  /**
   * Response caching. `true` for defaults, or `{ ttl, keyBy }`.
   *
   * A Junction concept, not a database one — the cache lives on the app and is
   * destroyed with it.
   */
  cache?:    CacheDeclaration

  /**
   * Explicit validation schema, in Litestone JSON-schema form.
   *
   * Rarely needed. When the database client carries its own `$schema` — every
   * Litestone client does — validation is derived from it automatically, so
   * this is only for a service whose accepted input should differ from its
   * table definition.
   *
   * Supplying it REPLACES the derived validator rather than stacking with it:
   * two validators on one payload produces a confusing 400 from whichever
   * happens to run first.
   */
  schema?:   import('./litestone.ts').LitestoneJsonSchema

  /** Custom service methods — any extra function-valued option. */
  [method: string]: unknown
}

// ─── Reserved keys — the single source of truth ───────────────────────────
// A service is "options + methods" in one object, so every consumer needs the
// same answer to "is this key configuration or a callable method?". These sets
// used to be copy-pasted in five places (both factories here, createLitestoneService,
// the manifest plugin, the openapi plugin) and had already drifted — the plugin
// copies were missing `update`/`_update`, so every service reported `update` as
// a custom action. Import these instead of writing a sixth list.

/** Option keys consumed by the service factories — never custom methods. */
export const SERVICE_OPTION_KEYS: ReadonlySet<string> = new Set([
  'name', 'model', 'db', 'paginate', 'allowBulk',
  'idField', 'softDelete', 'cache', 'schema', 'hooks',
  // `publish` accepts a function, so without this a service declaring
  // `publish: (rows, ctx) => …` would have had it copied on as a callable
  // custom method and routed over HTTP as an action.
  'channel',
])

/** Keys present on a *built* Service — CRUD, bypass twins, and internals. */
export const SERVICE_RUNTIME_KEYS: ReadonlySet<string> = new Set([
  'find', 'get', 'create', 'update', 'patch', 'remove', 'restore',
  '_find', '_get', '_create', '_update', '_patch', '_remove', '_restore',
  '_hookMap', '_pipelines', '_compiledPipelines', '_meta', '_schemas',
])

/**
 * The one predicate for "is this a custom service method (action)?".
 * Used by both factories to decide what to copy onto the service, and by the
 * manifest/openapi plugins to decide what to advertise.
 */
export function isCustomMethod(key: string, value: unknown): boolean {
  return typeof value === 'function'
    && !SERVICE_OPTION_KEYS.has(key)
    && !SERVICE_RUNTIME_KEYS.has(key)
}

/** Custom method (action) names on a service definition or built service. */
export function customMethodNames(obj: object): string[] {
  return Object.keys(obj).filter(
    k => isCustomMethod(k, (obj as Record<string, unknown>)[k])
  )
}

export function createBaseService(
  opts: BaseServiceOptions
): Omit<Service, 'name' | '_pipelines' | 'hooks'> & Partial<Pick<Service, 'name' | 'hooks'>> {

  // ── Single CRUD code path ─────────────────────────────────────────────
  // createBaseService used to carry its own parallel find/get/create/...
  // implementation that had drifted from createLitestoneBase (no $gt/$in
  // operator translation, no soft-delete handling, divergent orderBy
  // shapes). It now DELEGATES to createLitestoneBase — one implementation,
  // one query dialect — and adapts plain db clients to the litestone table
  // surface where needed (see adaptPlainClient).
  //
  // Semantics preserved from the old base:
  //   • allowBulk defaults to FALSE here (explicit opt-in for bulk writes),
  //     while createLitestoneBase's own default is true.
  //   • The db() thunk is honoured per call: ctx.locals.db is seeded from
  //     it unless a request-scoped client is already there (withLitestoneDb
  //     always wins).

  const { model, name, hooks, db, paginate, allowBulk, idField, softDelete, cache, schema, channel } = opts

  const base = createLitestoneBase({
    model,
    idField,
    softDelete,
    paginate:  paginate ?? { default: 20, max: 100 },
    allowBulk: allowBulk ?? false,
  })

  type Method = (ctx: ServiceContext) => Promise<unknown>
  const withDb = (fn: Method): Method => (ctx) => {
    if (!ctx.locals.db) {
      // Resolution order: explicit db() thunk → the app's database.
      // (ctx.locals.db already set — e.g. by withLitestoneDb — always wins.)
      const source = db ? db() : (ctx.app as { db?: unknown } | undefined)?.db
      if (!source) {
        throw new Error(
          `Service base for model '${model}': no database available — ` +
          `pass db: () => client, or createApp({ db })`
        )
      }

      // Reaching app.db for a Litestone client means per-request scoping never
      // ran. That used to fall through silently and hand the service the ROOT
      // client: policies then compared against a null auth() and matched
      // nothing, so the service returned empty results and looked broken rather
      // than misconfigured.
      //
      // createApp({ db }) installs the scoping automatically, so there is no
      // longer a legitimate way to arrive here with a Litestone client.
      if (typeof (source as { $setAuth?: unknown }).$setAuth === 'function') {
        throw new Error(
          `Service base for model '${model}': reached app.db without request scoping. ` +
          `A Litestone client must be scoped per request or row policies see no auth. ` +
          `Pass the client as createApp({ db }) — it installs the scoping hook — ` +
          `or add withLitestoneDb(db) to your app around hooks.`
        )
      }

      ctx.locals.db = adaptPlainClient(source) as typeof ctx.locals.db
    }
    return fn(ctx)
  }

  // Custom methods — any extra function-valued option.
  const customMethods: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(opts)) {
    if (isCustomMethod(key, val)) customMethods[key] = val
  }

  // Schema validation, derived rather than declared.
  //
  // When the resolved client is a Litestone client it carries its own parsed
  // schema, so the field rules already exist — @length, @email, @gte. These
  // hooks read them at call time and reject bad input with a 400 naming the
  // field, instead of letting it reach the database and surface as a driver
  // error. A non-Litestone client resolves to no schema and they no-op.
  //
  // Everything is lazy because the client is not known when this service module
  // is imported. User hooks run first, so a before/create hook can still shape
  // ctx.data before it is validated.
  // Auth is derived from the model's @@gate, per operation — so a model
  // declaring `@@gate("0.4")` has public reads and authenticated writes with no
  // service-level declaration at all. Runs before validation: rejecting an
  // anonymous request costs less than parsing its body.
  const derivedHooks: HookMap = {
    before: {
      find:   [gateAuth(model, 'read')],
      get:    [gateAuth(model, 'read')],
      create: [gateAuth(model, 'create'), autoValidate(model, 'create')],
      patch:  [gateAuth(model, 'update'), autoValidate(model, 'patch')],
      update: [gateAuth(model, 'update'), autoValidate(model, 'create')],
      remove: [gateAuth(model, 'delete')],
    },
  }

  // User hooks run first, so a before/create hook can still shape ctx.data
  // before it is validated, and an app can add its own checks ahead of these.
  const mergedHooks: HookMap = hooks
    ? {
        ...hooks,
        before: (() => {
          const out: Record<string, unknown[]> = { ...(hooks.before as Record<string, unknown[]> ?? {}) }
          for (const [method, derived] of Object.entries(derivedHooks.before!)) {
            out[method] = [...(out[method] ?? []), ...(derived as unknown[])]
          }
          return out
        })() as HookMap['before'],
      }
    : derivedHooks

  // An explicit schema replaces the derived validator for create/patch.
  let explicitSchemas: { create: unknown; patch: unknown } | null = null
  if (schema) {
    // `model` may be omitted (resolved per-request from the service name), so
    // fall back to `name` here — an explicit schema is compiled once, up front,
    // and has no ctx to read.
    const accessor = model ?? name
    const defsKey =
      schema.$defs[name ?? '']         ? (name as string) :
      (accessor && schema.$defs[accessor]) ? accessor :
      accessor                         ? resolveDefsKey(schema, accessor)
                                       : null

    if (defsKey) {
      try {
        const create = createSchema(jsonSchemaToJunctionSchema(defsKey, schema, 'create'))
        const patch  = createSchema(jsonSchemaToJunctionSchema(defsKey, schema, 'update'))
        const before = mergedHooks.before as Record<string, unknown[]>
        before.create = [create.hook()]
        before.patch  = [patch.hook()]
        explicitSchemas = { create, patch }
      } catch (err) {
        console.warn(
          `[Junction] service '${name ?? model}': the supplied schema has no usable ` +
          `definition for '${defsKey}' (${(err as Error).message}). Falling back to ` +
          `the schema derived from the database client.`
        )
      }
    } else {
      console.warn(
        `[Junction] service '${name ?? model}': the supplied schema has no definition ` +
        `matching '${model}'. Falling back to the schema derived from the database client.`
      )
    }
  }

  // name/hooks are carried through rather than dropped. The loader spreads this
  // object into createService(), which is where both are read — so omitting
  // them here is what made the options-object form silently hook-less.
  return {
    find:    withDb(base.find),
    get:     withDb(base.get),
    create:  withDb(base.create),
    update:  withDb(base.update),
    patch:   withDb(base.patch),
    remove:  withDb(base.remove),
    restore: withDb(base.restore as Method),
    ...customMethods,
    ...(name    !== undefined ? { name }    : {}),
    ...(channel !== undefined ? { channel } : {}),
    hooks: mergedHooks,
    ...(cache      !== undefined ? { cache }      : {}),
    ...(allowBulk  !== undefined ? { allowBulk }  : {}),
    // Consumed by the openapi plugin, which prefers an explicit schema.
    ...(explicitSchemas ? { _schemas: explicitSchemas } : {}),
    // Consumed by the devtools/manifest plugins, which read service metadata.
    _meta: {
      softDelete: softDelete ?? null,
      cache:      !!cache,
      idField:    idField ?? 'id',
    },
  } as Omit<Service, 'name' | '_pipelines' | 'hooks'> & Partial<Pick<Service, 'name' | 'hooks'>>
}

// ─── Plain-client adapter ─────────────────────────────────────────────────
// createBaseService's documented db contract is a plain object of tables
// exposing findMany/count/findUnique/create/update/updateMany/delete/
// deleteMany. createLitestoneBase codes against the richer litestone table
// surface (findManyAndCount, remove/removeMany, $setAuth on the client).
// Real litestone clients pass through untouched; plain clients get a thin
// per-table adapter that fills the gaps.

function adaptPlainClient(client: unknown): unknown {
  const c = client as Record<string, unknown> & { $setAuth?: unknown }
  if (!c || typeof c !== 'object') return client
  if (typeof c.$setAuth === 'function') return client   // real litestone client

  const tableCache = new Map<PropertyKey, unknown>()
  return new Proxy(c, {
    get(target, prop) {
      const val = (target as Record<PropertyKey, unknown>)[prop]
      if (!val || typeof val !== 'object') return val
      let adapted = tableCache.get(prop)
      if (!adapted) {
        adapted = adaptPlainTable(val as Record<string, (...a: unknown[]) => Promise<unknown>>)
        tableCache.set(prop, adapted)
      }
      return adapted
    },
  })
}

function adaptPlainTable(t: Record<string, (...a: unknown[]) => Promise<unknown>>) {
  return {
    ...t,
    findManyAndCount: t.findManyAndCount ?? (async (args: Record<string, unknown> = {}) => {
      const { where, limit, offset, orderBy, select, include } = args as {
        where?: unknown; limit?: number; offset?: number
        orderBy?: unknown; select?: unknown; include?: unknown
      }
      const q: Record<string, unknown> = { where, take: limit, skip: offset }
      if (orderBy) q.orderBy = orderBy
      if (select)  q.select  = select
      if (include) q.include = include
      const [rows, total] = await Promise.all([
        t.findMany(q),
        t.count({ where }),
      ])
      return { rows, total }
    }),
    remove:     t.remove     ?? t.delete,
    removeMany: t.removeMany ?? t.deleteMany,
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
   * Broadcast this service's mutations to a WebSocket channel.
   *
   *   channel: 'posts'                              a channel name
   *   channel: (rows, ctx) => app.channel(`w:${…}`)  dynamic target
   *   channel: false                                declared opt-out
   *
   * Replaces the three-step wiring this used to require — import publish(),
   * build the hook, attach it per write method (and remember `after: { all }`
   * would broadcast every READ to every socket).
   *
   * Off unless declared. `fli make:*` scaffolds declare it, so a generated app
   * is live out of the box — the same split Feathers has between its core
   * (publishes nothing without a publisher) and its generator (writes one).
   */
  channel?:   PublishDeclaration

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
  update?:    (ctx: ServiceContext) => Promise<unknown>
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
    const rawTelemetry = (ctx.app as Record<string, unknown>)?.telemetry as EventEmitter | undefined
    const telemetry = telemetryEnabled(rawTelemetry) ? rawTelemetry : undefined
    try {
      return await fn(ctx)
    } finally {
      if (telemetry) {
        telemetry.emit('junction.call.end', {
          telemetryId: undefined,   // no pipeline correlation for bypass calls
          service:     serviceName,
          method,
          transport:   ctx.transport ?? 'internal',
          userId:      ctx.auth.user?.userId ?? null,
          id:          ctx.id,
          durationMs:  Date.now() - start,
          status:      ctx.error ? 'error' : 'ok',
        } satisfies TelemetryEvent)
      }
    }
  }
}

export function createService(def: ServiceDefinition): Service {

  // db is optional — the base falls back to ctx.app.db at call time, so
  // `createService({ name: 'posts', model: 'posts' })` is a complete service.
  //
  // def.hooks is forwarded so createBaseService can merge the model's derived
  // hooks (gateAuth from @@gate, autoValidate from field rules) after the
  // user's — the returned base.hooks carries both. Reading def.hooks here
  // instead used to silently drop the derived layer on the direct
  // createService({ model }) path: gates and validation then surfaced as raw
  // driver errors (500) instead of 401/400 pre-checks.
  // EVERY base option must be forwarded. This list used to stop at `hooks`,
  // silently dropping idField, softDelete and schema — so
  // `createService({ model, softDelete: 'deleted_at' })` HARD DELETED rows while
  // `createBaseService({ model, softDelete: 'deleted_at' })` soft-deleted them.
  // Same option name, same docs, opposite behaviour. Keep this in sync with
  // SERVICE_OPTION_KEYS; nothing here may be dropped on the way through.
  const base = def.model
    ? createBaseService({
        model:      def.model,
        name:       def.name,
        db:         def.db,
        paginate:   def.paginate,
        allowBulk:  def.allowBulk,
        idField:    def.idField    as string | undefined,
        softDelete: def.softDelete as string | undefined,
        schema:     def.schema     as import('./litestone.ts').LitestoneJsonSchema | undefined,
        hooks:      def.hooks,
      })
    : notImplementedBase()
  const baseHooks = def.model
    ? (base as unknown as { hooks?: HookMap }).hooks
    : undefined

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
  }
  // base.hooks already contains def.hooks merged with the derived hooks —
  // push it (not def.hooks) so both layers survive. Model-less services have
  // no derived layer, so def.hooks is used as-is.
  const effectiveHooks = baseHooks ?? def.hooks
  if (effectiveHooks) hookMaps.push(effectiveHooks)

  if (cacheHooks) {
    // Push after-cache hooks LAST — storeResult sees the fully transformed result
    hookMaps.push({
      after: {
        find:   [cacheHooks.storeResult],
        get:    [cacheHooks.storeResult],
        create: [cacheHooks.bustCache],
        update: [cacheHooks.bustCache],
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
    // Carried through so callService can find it after the pipeline. Reserved
    // in SERVICE_OPTION_KEYS, so a function form never becomes an action.
    ...(def.channel !== undefined ? { channel: def.channel as PublishDeclaration } : {}),
    // Same reason: declared, honoured internally, but previously not carried
    // onto the built service, so anything reading it back saw undefined.
    allowBulk: def.allowBulk ?? (base as { allowBulk?: boolean }).allowBulk ?? false,

    find:    def.find    ?? base.find,
    get:     def.get     ?? base.get,
    create:  def.create  ?? base.create,
    update:  def.update  ?? base.update,
    patch:   def.patch   ?? base.patch,
    remove:  def.remove  ?? base.remove,
    restore: def.restore ?? base.restore,

    // ── Hook-bypass methods ────────────────────────────────────────────────────
    // Direct method access — skips the hook pipeline entirely.
    // Emits a lightweight junction.call.end on app.telemetry (no start, no hooks).
    _find:    makeBypass(def.name, 'find',    def.find    ?? base.find),
    _get:     makeBypass(def.name, 'get',     def.get     ?? base.get),
    _create:  makeBypass(def.name, 'create',  def.create  ?? base.create),
    _update:  makeBypass(def.name, 'update',  def.update  ?? base.update),
    _patch:   makeBypass(def.name, 'patch',   def.patch   ?? base.patch),
    _remove:  makeBypass(def.name, 'remove',  def.remove  ?? base.remove),
    _restore: makeBypass(def.name, 'restore', def.restore ?? base.restore),

    hooks(map: HookMap): void {
      hookMaps.push(map)
      mergedMap          = mergeHookMaps(...hookMaps)
      pipelines          = resolvePipelines(mergedMap)
      service._hookMap   = mergedMap
      service._pipelines = pipelines
      // Invalidate the start()-compiled pipeline cache — it baked in the old
      // hook map and would otherwise silently win over these new hooks in
      // callService(). The registry re-compiles on its next setAppHooks(),
      // and ServiceRegistry.register() wraps this method to recompile
      // immediately for registered services.
      service._compiledPipelines = undefined
    },

    _hookMap:   mergedMap,
    _pipelines: pipelines,

    // Metadata built by createBaseService. Not copied through, these were lost
    // on the createService path — the primary public factory — so /manifest
    // reported softDelete:false / idField:'id' for every service regardless of
    // its actual config, and the openapi plugin never saw an explicit schema.
    ...(() => {
      const b = base as unknown as Record<string, unknown>
      return {
        ...(b._meta    !== undefined ? { _meta:    b._meta }    : {}),
        ...(b._schemas !== undefined ? { _schemas: b._schemas } : {}),
      }
    })(),
  }

  // Copy custom methods from def directly onto the service object.
  // Anything that is a function and not a reserved key becomes a callable method.
  for (const [key, val] of Object.entries(def)) {
    if (isCustomMethod(key, val)) (service as Record<string, unknown>)[key] = val
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

  // True once app.start() (or a post-start app.hooks() call) has provided
  // the app-level hook map — i.e. compiled pipelines exist and must be
  // recompiled when hooks change.
  get hasAppHooks(): boolean {
    return this._appHooks !== null
  }

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
    // Wrap hooks() so hooks added AFTER registration (including after
    // app.start()) recompile this service's pipeline cache immediately.
    // Without this, callService() keeps using the stale compiled pipelines
    // and late-added hooks silently never run.
    const origHooks = service.hooks.bind(service)
    service.hooks = (map) => {
      origHooks(map)
      if (this._appHooks) {
        service._compiledPipelines = resolvePipelines(
          mergeHookMaps(this._appHooks, service._hookMap)
        )
      }
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
  return { find: err, get: err, create: err, update: err, patch: err, remove: err, restore: undefined }
}

// (wrapResult moved to core/envelope.ts — the envelope is built, inspected and
// unwrapped in one module now. It used to be built here and taken apart in
// twelve other places, each with its own rules.)

// ─── Channel fan-out ──────────────────────────────────────────────────────

/**
 * Broadcast one record to the channels a service declares.
 *
 * No-ops unless BOTH are true: the channels plugin is loaded (it stamps the
 * manager on every context), and the service declared `publish`. Broadcasting
 * is opt-in on purpose — `@@allow` row policies are enforced when a row is
 * READ, and a broadcast does not re-evaluate them per subscriber, so a default
 * of "announce everything" would hand every connection in a channel rows it
 * could never have fetched. Feathers has the same split: its core publishes
 * nothing without a publisher, and its *generator* writes one for you.
 * Junction's `fli make:*` scaffolds do the same.
 */
async function publishToChannels(
  service: Service,
  ctx:     ServiceContext,
  event:   string,
  payload: unknown
): Promise<void> {
  const decl = service.channel as PublishDeclaration | undefined
  if (decl === undefined || decl === false) return

  const manager = ctx.locals.__channels as {
    channel:  (name: string) => unknown
    publish:  (event: string, data: unknown, ctx: ServiceContext, fn: (d: unknown, c: ServiceContext) => unknown) => Promise<void>
  } | undefined
  if (!manager) return

  const resolve = typeof decl === 'string'
    ? () => manager.channel(decl)
    : decl

  try {
    await manager.publish(event, payload, ctx, resolve as never)
  } catch {
    // A broadcast failure must not fail the write. The record is already
    // committed; a dead socket is not the caller's problem.
  }
}

// (parseSortParam / parseSelectParam removed — the merged base delegates
// query parsing to litestone.ts's parseSort / parseSelect, one dialect.)
