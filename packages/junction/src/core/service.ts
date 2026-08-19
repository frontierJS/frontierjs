// core/service.ts
// Service layer — the heart of the framework.
// createBaseService() exposes the 5 CRUD methods.
// createService() composes hooks + base + custom overrides.
// Services are registered in the app and called by the transport.

import type { ServiceContext, ServiceMethod } from './context.ts'
import { requestMeta, runWithMeta, runInServiceCall, withCallEffects } from './context.ts'
import { claimIdempotency } from './idempotency.ts'
import { diagnostic, isDiagnosticMode } from './diagnostics.ts'
import {
  resolvePipelines,
  mergeHookMaps,
  runPipeline,
  type Hook,
  type AroundHook,
  type HookMap,
  type ResolvedPipeline
} from './hooks.ts'
import { NotFound, BadRequest, MethodNotAllowed, toFrameworkError } from './errors.ts'
import { createMemoryCache, type ICache }         from '../cache/index.ts'
import { wrapResult, isServiceResult, resultData } from './envelope.ts'
// NOTE: service.ts ⇄ litestone.ts is an intentional, safe ESM cycle:
// litestone imports createService (used only inside functions) and this
// module imports createLitestoneBase (used only inside createBaseService).
import { createSchema } from './schema.ts'
import { isPublishHook } from '../transport/channels.ts'
import {
  createLitestoneBase, autoValidate, gateAuth, autoFilter, autoSort, liftReservedQuery,
  markDerived, isDerivedHook,
  jsonSchemaToJunctionSchema, resolveDefsKey, announcementPayload,
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
 * Named `channel` and not `publish`: 'publish' is a perfectly ordinary METHOD
 * name (publish a draft), and reserving it as an option key would stop a
 * service from having one. A noun cannot collide with a verb-shaped method.
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

/**
 * A service, described. Everything a reader outside the core needs, and nothing
 * that is an implementation detail of how the service was built.
 */
export interface ServiceDescription {
  name:       string
  model:      string
  /** Declared custom methods, before the method policy. */
  customMethods: string[]
  /** What the service will answer, policy applied. */
  methods:    string[]
  allowBulk:  boolean
  /** Row cap on one filtered bulk patch/remove. */
  bulkMax:    number
  /**
   * Query keys this service owns rather than filters on. Reported for the same
   * reason `allowBulk` is: a caller cannot tell a reserved key from a column by
   * looking at the URL, and `/manifest` is where that kind of question is asked.
   */
  reservedQuery: string[]
  softDelete: string | null
  cache:      boolean
  idField:    string
  /** Methods that run inside a transaction spanning the whole pipeline. */
  transactional: string[]
  /** The merged hook declaration — what ran, not how it was resolved. */
  hooks:      HookMap
  /**
   * Where this service's mutations are broadcast, as something a JSON reader
   * can hold: the channel name for the string form, `true` for a function
   * target, `false` for the declared opt-out, and `null` for a service that
   * declares nothing — which falls through to the app-level
   * `publishDefault()` if one is registered.
   */
  channel:    string | boolean | null
  /** Present when the service was given an explicit schema. */
  schemas?:   { create?: unknown; patch?: unknown }
}

/**
 * Which methods run inside a database transaction spanning the WHOLE pipeline.
 *
 *   transactional: true                every mutating method
 *   transactional: ['create', 'pay']   these, named
 *   transactional: false               declared opt-out
 *
 * `find`/`get` are never wrapped whatever is declared — a read taking
 * `BEGIN IMMEDIATE` would serialise every reader behind every other.
 */
export type TransactionalDeclaration = boolean | string[]

export interface Service {
  name:     string
  model?:   string   // model name — used in result envelope object field
  /** Channel(s) to broadcast mutations to. Omitted = no broadcast. */
  channel?: PublishDeclaration
  /** Methods wrapped in a transaction, resolved from the declaration. */
  _transactional?: readonly string[]
  /**
   * Whether bulk (query-targeted, id-less) writes are permitted.
   *
   * Carried onto the built service so consumers can read it back. It was
   * declared on ServiceDefinition and honoured internally, but never landed
   * on the service object — so `/metrics` reported `allowBulk: false` for
   * every service, including ones configured `allowBulk: true`.
   */
  allowBulk?: boolean

  /**
   * Row cap on one filtered bulk patch/remove, carried for the same reason
   * `allowBulk` is: `/metrics` and `describe()` report it.
   */
  bulkMax?: number

  /**
   * Query keys this service owns rather than filters on — see the declaration.
   * Carried onto the built service because `callService` reads it off the
   * service, which is the only thing it holds when the context is already made.
   */
  reservedQuery?: readonly string[]

  /**
   * The DECLARATION, as written — `['find','get']` or `'readOnly'`.
   *
   * Carried on the object because `createBaseService` returns options for
   * `createService` to resolve, and the loader spreads one into the other.
   * `_methods` below is the resolved form and the one to read.
   */
  methods?: MethodPolicy

  /**
   * The resolved method allow-list, or null when none was declared.
   *
   * Read it through `isMethodAllowed()` / `allowedMethodNames()` rather than
   * directly — those are what callService and the three advertisers agree on.
   */
  _methods?: Set<string> | null

  find:     (ctx: ServiceContext) => Promise<unknown>
  get:      (ctx: ServiceContext) => Promise<unknown>
  create:   (ctx: ServiceContext) => Promise<unknown>
  update:   (ctx: ServiceContext) => Promise<unknown>
  patch:    (ctx: ServiceContext) => Promise<unknown>
  remove:   (ctx: ServiceContext) => Promise<unknown>
  restore?: (ctx: ServiceContext) => Promise<unknown>

  // Hook registration — can be called multiple times, hooks accumulate
  hooks:    (map: HookMap) => void

  /**
   * The resolved pipelines for these app-level hooks.
   *
   * The one owner. Memoised on the app map's identity and a version this
   * service's own `hooks()` bumps, so both inputs are in the key and a stale
   * answer cannot be handed out. Callers pass the app hooks they intend to run;
   * they get pipelines that include them.
   */
  pipelines: (appHooks?: HookMap | null) => Record<string, ResolvedPipeline>

  /**
   * What this service IS — the one answer, for anything that describes it.
   *
   * /manifest, the OpenAPI generator and /metrics each used to reach into
   * `_meta`, `_schemas`, `_hookMap` and the custom-method rule directly, casting on the
   * way in. Three readers of four internals is three chances to read a
   * different service than the one that answers the request.
   */
  describe: () => ServiceDescription

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

  // Internal. The merged declaration — read by pipelines() and by /manifest.
  // There is no separate resolved copy: one existed, and keeping the two
  // agreeing was a hand job with four writers.
  _hookMap: HookMap

  /**
   * The service's custom methods, resolved once at construction.
   *
   * Dispatch and the three advertisers (manifest, OpenAPI, /metrics) read this
   * rather than re-deciding what counts as a custom method. They are also own keys
   * on the service, so `svc.reboot` still works and a spread still carries them
   * — the table is what is authoritative.
   */
  _customMethods: CustomMethodMap
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

// Warned once per service+method, so a table miss is loud but not a per-request
// log flood.
const _warnedUntabled = new Set<string>()

/**
 * The function behind a custom method name, or undefined.
 *
 * The table is the answer. The fallback to an own key is a transition: a method
 * attached to a service object AFTER construction was never a supported shape,
 * but nothing refused it either, and a silent 404 is the worst way to find out.
 */
function customMethodFn(service: Service, method: string): CustomMethodFn | undefined {
  const declared = service._customMethods?.[method]
  if (declared) return declared

  const attached = (service as unknown as Record<string, unknown>)[method]
  if (typeof attached !== 'function') return undefined

  const key = `${service.name}.${method}`
  if (!_warnedUntabled.has(key)) {
    _warnedUntabled.add(key)
    console.warn(
      `[Junction] service '${service.name}': custom method '${method}' is on the ` +
      `service object but not in its method table, so it was attached after ` +
      `construction. ` +
      `Declare it on the definition — a later release dispatches from the table alone.`
    )
  }
  return attached as CustomMethodFn
}

export async function callService(
  service:    Service,
  ctx:        ServiceContext,
  appHooks?:  HookMap,
  events?:    EventEmitter,
  telemetry?: EventEmitter
): Promise<void> {
  // ── the principal propagates from the CALLING CONTEXT ────────────────
  //
  // The request store already covers a whole pipeline run, so a nested call
  // that names no principal inherits the request's. That is right until a call
  // deliberately changes principal: service A running as alice calls B as bob,
  // and anything B calls would inherit ALICE — the request's — rather than the
  // context it is actually running inside.
  //
  // So the scope is re-established whenever this call's principal differs from
  // the one in scope. Only then: an ALS `run()` on every service call would be
  // paid by the common path, where the two are the same object by construction.
  // A call that enters with NO store is an entry point of its own — a job, a
  // script, a test, a boot task. It opens one, which is what gives background
  // work a principal to propagate at all.
  const scoped = requestMeta()

  if (!scoped) {
    return runWithMeta(
      { correlationId: crypto.randomUUID(), origin: 'internal', user: ctx.auth.user },
      () => _callService(service, ctx, appHooks, events, telemetry))
  }

  if (scoped.user !== ctx.auth.user) {
    return runWithMeta({ ...scoped, user: ctx.auth.user }, () =>
      _callService(service, ctx, appHooks, events, telemetry))
  }

  return _callService(service, ctx, appHooks, events, telemetry)
}

async function _callService(
  service:    Service,
  ctx:        ServiceContext,
  appHooks?:  HookMap,
  events?:    EventEmitter,
  telemetry?: EventEmitter
): Promise<void> {

  const start  = Date.now()
  const method = ctx.method
  const isCustom = !CRUD_METHODS.has(method as string)

  // ── The method policy ────────────────────────────────────────────────
  // Enforced HERE because callService is the one path every caller takes —
  // HTTP, WebSocket, a job, and `app.service('audit').create()` from inside
  // the process. Putting it in the transport would leave the internal caller
  // free to do what the wire is refused, which is the shape of most of the
  // "the guard was somewhere else" bugs in this repo (Invariant 4).
  //
  // 405, not 404: the service exists and the route is real, the verb is not
  // offered. A 404 would send someone looking for a mounting problem.
  //
  // BEFORE the hook pipeline, which means an anonymous caller gets 405 rather
  // than the 401 an authenticate hook would have raised. That is deliberate on
  // two counts. The policy is structural, not authorization — it says "nobody
  // may, ever", so there is nothing an identity could change, and it is already
  // public in /manifest and the OpenAPI spec. And running `before` hooks for a
  // call that cannot proceed means running their side effects: a rate-limit
  // counter incremented, a row touched, for a verb the service does not have.
  // It matches the method-existence NotFound directly below, which has always
  // answered ahead of the pipeline for the same reason.
  if (!isMethodAllowed(service, method as string)) {
    throw new MethodNotAllowed(
      `Service '${service.name}' does not offer '${method}' ` +
      `(allowed: ${allowedMethodNames(service).join(', ') || 'none'})`
    )
  }

  // For custom methods, check the service has it registered
  if (isCustom && !customMethodFn(service, method as string)) {
    throw new NotFound(`Method '${method}' not found on service '${service.name}'`)
  }

  // ── Idempotency-Key ──────────────────────────────────────────────────
  // Claimed HERE for the same reason the method policy is: callService is the
  // one path every caller takes, and a guarantee that holds over HTTP but not
  // over a socket is not a guarantee. A replay answers the FIRST call's result
  // without running the pipeline, so nothing after this line happens twice —
  // no hook, no write, no announcement.
  //
  // Nothing is claimed unless the request carried a key, so an app that never
  // sends one is on exactly the path it was on before.
  const idem = claimIdempotency(
    ctx,
    requestMeta()?.idempotencyKey,
    (ctx.app as { config?: { idempotency?: import('./idempotency.ts').IdempotencyConfig } } | undefined)
      ?.config?.idempotency
  )

  if (idem?.replay) {
    ctx.result = idem.result
    return
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

  // Before the pipeline, not inside it: a reserved key must be off ctx.query by
  // the time ANY hook reads it — the app's own leading hook as much as the
  // derived autoFilter behind it — and a custom method runs neither.
  liftReservedQuery(ctx, service.name, service.reservedQuery)

  // One owner, memoised on the app hooks it was HANDED — so a call always runs
  // the hooks its caller passed, which the old compiled-cache rung could not
  // promise.
  const pipelineSource = service.pipelines(appHooks)

  // Hook-less custom methods fall back to the '*' pipeline (app/service
  // 'all' hooks only) — never to an empty one, which would silently skip
  // Litestone scoping and every other app-level hook.
  const resolvedPipeline = pipelineSource[method as string]
    ?? pipelineSource['*']
    ?? { around: [], before: [], after: [], error: [] }

  const methodFn = (isCustom
    ? customMethodFn(service, method as string)
    : service[method as ServiceMethod]) as (ctx: ServiceContext) => Promise<unknown>

  // Every context the three builders make arrives with one. A hand-built
  // context — a test, an app calling a service method with a literal — does
  // not, and a hook that queues an effect must not be the thing that throws.
  if (typeof ctx.afterCommit !== 'function') withCallEffects(ctx)

  let pipelineError: unknown = null

  try {
    // Marked for the whole pipeline, hooks included: a write from an `after`
    // hook belongs to this call and is covered by the announcement below.
    // Anything the Litestone tap sees OUTSIDE this scope is a write no service
    // announced, which is what it exists to catch.
    await runInServiceCall(service.name, () => runPipeline(ctx, resolvedPipeline, async () => {
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
        // A find promises a list, and nothing is not an empty list. Left to
        // fall through it answered 204, which reaches the browser as an empty
        // body — indistinguishable from a page with no rows, and the screen
        // then renders nothing while the service is the thing at fault.
        if (ctx.method === 'find') wrapResult(raw, service.name, 'find')
        ctx.result = null
      } else if (isServiceResult(raw)) {
        ctx.result = raw
      } else {
        // `object` names the SERVICE, so a client can key a cache or a type off
        // it without first working out which kind it is holding. The METHOD is
        // what decides list vs single — see wrapResult.
        ctx.result = wrapResult(raw, service.name, ctx.method)
      }
    }, t))   // gated: undefined when no telemetry subscribers → per-hook fast path
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
  // A CRUD write announces under its past-tense name; a CUSTOM method announces
  // under its own (`orders pay`), because it is a write too — `db.order
  // .transition(id,'pay')` changes the row exactly as a patch does. Until
  // 2026-08-06 only the map counted, so a custom method changed a row and told
  // nobody: the browser client had listened for those events since it was
  // written (client/index.ts), and the server had never sent one. Apps hid it by
  // re-issuing find() after every call.
  //
  // Reads never announce, which is why `find`/`get` are excluded by name rather
  // than by shape. A custom method that only READS (search, stats, export) is
  // indistinguishable from one that writes at this layer — it opts out with
  // `ctx.dispatch = false`, the same switch that suppresses any other broadcast.
  const eventName = AUTO_EVENT_MAP[method as string]
    ?? (isCustom ? (method as string) : undefined)

  if (!ctx.error && !pipelineError && eventName) {
    const past = eventName

    // ctx.dispatch is the ONE suppression/override switch, honoured by both
    // consumers: `false` announces nothing, any other value replaces the
    // payload (redaction, shaping). Previously only the socket obeyed it, so
    // a hook that suppressed a broadcast still leaked the record to every
    // server-side subscriber — including the webhook fan-out.
    if (ctx.dispatch !== false) {
      let payload = ctx.dispatch !== undefined ? ctx.dispatch : resultData(ctx.result)

      // An announcement is about a ROW, so it carries one — see
      // announcementPayload. A method free to answer a projection is not free
      // to broadcast one: the subscriber has nowhere to put it and says nothing
      // about that. Skipped when the app stated the payload itself; ctx.dispatch
      // is a declaration of what to send, and second-guessing it would make the
      // switch mean two things.
      if (ctx.dispatch === undefined) {
        payload = await announcementPayload(
          ctx, payload, (service as { model?: string }).model ?? service.name,
          (service as { idField?: string }).idField ?? 'id'
        )
      }

      // null means announce nothing — and it has to skip the fan-out WITHOUT
      // leaving callService, or the pipeline error below is never re-thrown.
      if (payload !== null) {
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
  }

  // ── after commit ──────────────────────────────────────────────────
  //
  // The phase an `after` hook is not. `after` runs in sequence with the other
  // after hooks, so an email sent from one goes out and a later hook throwing
  // still fails the call — and under `transactional:` rolls the write back with
  // the email already gone (`FJS-089`). What is queued here runs once, here,
  // and only on the success path.
  //
  // AFTER the transaction, without knowing one existed: `transactional:` is an
  // `around` hook, so `runPipeline` has already returned by the time this line
  // is reached — the commit happened when `$transaction` resolved. Without one,
  // the same condition means the pipeline finished, which is the guarantee
  // being offered and the same one the announcement above uses.
  //
  // Before `idem.settle` for the reason the announcement is: a replay must not
  // be told the call is finished while its effects are still running.
  if (!ctx.error && !pipelineError && ctx._afterCommit?.length) {
    const queued = ctx._afterCommit
    ctx._afterCommit = []
    for (const fn of queued) {
      try {
        await fn()
      } catch (err) {
        // Observer tier (FJS-D06): the write is committed and the announcement
        // is out, so this cannot be reported as the call failing — a 500 here
        // would tell the client a write failed that did not. Loud, though: a
        // swallowed effect with no signal is the defect this phase exists to
        // stop, wearing different clothes.
        const e = err as Error
        console.error(
          `[Junction] afterCommit callback threw in '${service.name}.${method as string}': ${e?.message}. ` +
          `The call succeeded and was announced; this effect did not run.`
        )
        t?.emit('junction.aftercommit.error', {
          telemetryId: ctx.telemetryId,
          service:     service.name,
          method:      method as string,
          error:       { name: e?.name, message: e?.message },
        })
      }
    }
  }

  // ── outbox handoff ────────────────────────────────────────────────
  //
  // The rows are committed, so the relay's own timer would find them; this
  // only buys the latency between committing an effect and queueing it.
  // Deliberately NOT awaited — the caller is waiting on a response, the work
  // is already durable, and the sweep is the backstop that makes that safe.
  if (!ctx.error && !pipelineError && ctx._outbox?.length) {
    ctx._outbox = []
    void ctx.app?.outbox?.deliver().catch((err: unknown) => {
      // A failed pass is not a failed call: the row is committed and owed, and
      // the next sweep will try again. Loud, because a relay that cannot reach
      // its queue at all is silent otherwise.
      ctx.app?.logger?.error?.('[Junction] outbox delivery kick failed', {
        service: service.name,
        method:  method as string,
        error:   (err as Error)?.message,
      })
    })
  }

  // Settle the key AFTER the announcement, so a replay cannot arrive between
  // the write and the broadcast and be told the call is finished while the
  // open tabs have not heard about it. A failed call releases the key.
  idem?.settle(!ctx.error && !pipelineError, ctx.result)

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

  /** See ServiceDefinition.transactional. */
  transactional?: TransactionalDeclaration

  /**
   * Narrow what this service answers — `['find','get']`, or `'readOnly'`.
   *
   * Same key and same meaning as on `createService`; carried through and
   * resolved there, against the custom methods that exist. Declaring it here used to
   * do NOTHING — the option was neither read nor forwarded, so an append-only
   * service written with this factory answered every verb and the only symptom
   * was a write that worked.
   */
  methods?:  MethodPolicy

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
   * How many rows one filtered bulk patch/remove may touch. Default 1000.
   *
   * Those run one statement per row so that `@@transitions` and `@version` are
   * enforced and each row gets its own outcome — which means an unbounded
   * filter is an unbounded number of statements under the write lock.
   */
  bulkMax?: number

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
  [method: string]: ServiceDefinitionValue
}

/**
 * What a key neither factory declares may hold — a custom method, or an option
 * a plugin reads.
 *
 * Spelled as a union rather than `unknown` for one reason. Under `unknown`
 * nothing contextually types a custom method's parameter, so the documented
 * shape
 *
 *   createService({ name: 'servers', async reboot(ctx) { … } })
 *
 * gives `ctx` an implicit `any` — a hard error in any app with `noImplicitAny`
 * on, and a silently untyped `ctx` in every app without it. A union carrying
 * exactly ONE function type contextually types the function-valued keys and
 * still accepts every option value, which `unknown` and `| unknown` both
 * cannot: a union with `unknown` in it collapses back to `unknown`.
 */
export type ServiceDefinitionValue =
  | ((ctx: ServiceContext) => Promise<unknown>)
  | string | number | boolean | bigint | symbol | object | null | undefined

// ─── Reserved keys — the single source of truth ───────────────────────────
// A service is "options + methods" in one object, so every consumer needs the
// same answer to "is this key configuration or a callable method?". These sets
// used to be copy-pasted in five places (both factories here, createLitestoneService,
// the manifest plugin, the openapi plugin) and had already drifted — the plugin
// copies were missing `update`/`_update`, so every service reported `update` as
// a custom method. Import these instead of writing a sixth list.

/** Option keys consumed by the service factories — never custom methods. */
export const SERVICE_OPTION_KEYS: ReadonlySet<string> = new Set([
  'name', 'model', 'db', 'paginate', 'allowBulk', 'bulkMax',
  'idField', 'softDelete', 'cache', 'schema', 'hooks',
  // `publish` accepts a function, so without this a service declaring
  // `publish: (rows, ctx) => …` would have had it copied on as a callable
  // custom method and routed over HTTP as one.
  'channel',
  'methods',
  'transactional',
  'reservedQuery',
])

/** Keys present on a *built* Service — CRUD, bypass twins, and internals. */
export const SERVICE_RUNTIME_KEYS: ReadonlySet<string> = new Set([
  'find', 'get', 'create', 'update', 'patch', 'remove', 'restore',
  '_find', '_get', '_create', '_update', '_patch', '_remove', '_restore',
  '_hookMap', '_meta', '_schemas', '_methods', '_customMethods', '_transactional',
  'pipelines', 'describe',
])

// ─── Custom methods: the one parse step ───────────────────────────────────
//
// A custom method used to be recognised by EXCLUSION — a function whose key is in
// neither reserved set — and six consumers re-applied that rule: dispatch twice,
// the method policy, the manifest, the OpenAPI spec and /metrics. Six copies of
// one question, none of them able to answer it any better than the deny-lists
// happened to be that day, and the deny-lists had already drifted across five
// copies once.
//
// It is answered once now, at construction, and everything downstream reads the
// resulting table. The exclusion rule survives as this function's fallback, so
// nothing written today changes shape — but `methods:` DECLARES, and a
// declaration beats a guess:
//
//   methods: ['find', 'get', 'reboot']   → 'reboot' is a custom method, stated
//   (no methods:)                        → scan, exactly as before
//
// The declaration is also the only way to name a method after an option key.
// `cache`, `schema`, `channel` and the rest of SERVICE_OPTION_KEYS are eaten by
// the scan with no error, so `async cache(ctx)` was simply impossible. It still
// costs a cast in TypeScript where the option is typed — `cache` is declared as
// a CacheDeclaration and cannot also be a function — so the runtime honours the
// declaration and the type does not know about it.

export type CustomMethodFn  = (ctx: ServiceContext) => Promise<unknown> | unknown
export type CustomMethodMap = Record<string, CustomMethodFn>

/**
 * The custom methods a definition declares, resolved to functions.
 *
 * `declared` is the `methods:` list when there is one. Names in it that are not
 * CRUD are custom methods and are resolved off the source; a name with no function
 * behind it throws, because the alternative is a 405 in production for a method
 * the author believed they had shipped.
 */
export function collectCustomMethods(
  source:      object,
  serviceName: string,
  declared?:   MethodPolicy,
): CustomMethodMap {
  const src = source as Record<string, unknown>
  const out: CustomMethodMap = {}

  if (Array.isArray(declared)) {
    for (const name of declared) {
      if (CRUD_METHODS.has(name)) continue
      const fn = src[name]
      if (typeof fn !== 'function') {
        // Name what IS on offer. A typo'd allow-list entry (`'fnid'`) is the
        // common case, and the message that only repeats what the caller wrote
        // is the least useful moment to be terse.
        const available = [
          ...CRUD_METHODS,
          ...Object.entries(src).filter(([k, v]) => isCustomMethod(k, v)).map(([k]) => k),
        ].sort().join(', ')

        throw new TypeError(
          `[Junction] service '${serviceName}': methods lists '${name}', which is ` +
          (fn === undefined
            ? `not defined on this service.`
            : `a ${typeof fn}, not a method — rename the option or the method, ` +
              `a name cannot be both.`) +
          ` Available: ${available}`
        )
      }
      out[name] = fn as CustomMethodFn
    }
    return out
  }

  // No declaration — the historical scan. Kept because 60-odd services in this
  // repo alone are written that way and none of them is wrong.
  for (const [key, val] of Object.entries(src)) {
    if (isCustomMethod(key, val)) out[key] = val as CustomMethodFn
  }
  return out
}

/** The custom method names on a built service (or, for a definition, by scanning). */
export function customMethodNames(svc: object): string[] {
  const table = (svc as { _customMethods?: CustomMethodMap })._customMethods
  return table ? Object.keys(table) : scanCustomMethods(svc)
}

// ─── The transaction scope ────────────────────────────────────────────────
//
// `around` is the only phase that wraps the after hooks, which is what makes
// this a commit scope rather than a longer before hook: the transaction covers
// before → method → after, so a later `after` hook throwing rolls the write
// back instead of leaving a committed row behind a rejected response.
//
// Two orderings carry it, and both already hold:
//
//   · `withLitestoneDb` is an APP-level around hook and app hooks merge first,
//     so it runs outside this one — `ctx.locals.db` is already the caller-scoped
//     client, and `$setAuth(u).$transaction(…)` passes its own proxy through, so
//     row policies and auth() survive into the transaction.
//   · the announcement happens in callService AFTER runPipeline, so the write
//     lock is released before anything fans out to a socket.
//
// A nested `app.service('x')` call needs no propagation: every client flavour
// shares one write connection and one depth counter, so its writes land inside
// this transaction and its reads see them (litestone `FJS-237` is what keeps
// that true under concurrency).
//
// Reads are excluded BY NAME rather than by guessing from the method's shape —
// the same rule the announcement uses. A read taking BEGIN IMMEDIATE would
// serialise every reader behind every other.
const NON_TRANSACTIONAL_METHODS = new Set(['find', 'get'])

export function resolveTransactional(
  decl:    TransactionalDeclaration | undefined,
  methods: readonly string[]
): readonly string[] {
  if (decl === undefined || decl === false) return []
  const wanted = decl === true ? methods : decl
  return wanted.filter(m => !NON_TRANSACTIONAL_METHODS.has(m))
}

function transactionScopeHook(serviceName: string, decl: TransactionalDeclaration): AroundHook {
  return markDerived(async function transactionScope(ctx: ServiceContext, next: () => Promise<void>) {
    // Registered on `all` and filtered here rather than expanded into a
    // per-method map at construction: the full method list is not resolved until
    // after the hooks are pushed, and one runtime check is cheaper than keeping
    // two derivations of "which methods" in step.
    const method = ctx.method as string
    if (NON_TRANSACTIONAL_METHODS.has(method)) return next()
    if (Array.isArray(decl) && !decl.includes(method)) return next()

    type TxClient = NonNullable<typeof ctx.locals.db>
    const db = ctx.locals.db as { $transaction?: (fn: (tx: TxClient) => Promise<void>) => Promise<void> }
    if (typeof db?.$transaction !== 'function')
      throw new Error(
        `Service '${serviceName}' declares transactional: but ctx.locals.db has no $transaction. ` +
        `The scope comes from the Litestone client — build the app with createApp({ db }), or drop the declaration. ` +
        `Silently running without one would report a transaction nobody opened.`
      )
    await db.$transaction(async (tx) => {
      // The whole trick, and the reason this is a framework hook rather than a
      // recipe: the method and every later hook must WRITE through the tx
      // client. Omit this by hand and the transaction is empty, the writes
      // commit outside it, and every test still passes.
      ctx.locals.db = tx
      await next()
    })
  })
}

// ─── One announcement per mutation ────────────────────────────────────────
//
// Two mechanisms broadcast, and a service can carry both: `channel:` is
// announced by callService at the single announcement point, and the exported
// `publish()` hook sends its own frame from `after`. Together they put the same
// record on the wire twice — every subscribed tab applies it twice, and a
// non-idempotent client handler (an append, a counter, a toast) shows it twice.
//
// It was tracked as "grep before merging" (FJS-045), which is a rule nobody can
// be relied on to follow and which no test can check. This is the same question
// asked where it can be answered: the resolved pipeline is the only place the
// FULL effective chain is known — service hooks, and the app-level hooks a
// `after: { all: [publish(…)] }` would apply to every service at once.
//
// Marked hooks, never names: an app is free to call its own hook `publish`, and
// suppressing a real one on a name match would silently stop broadcasting.
function refuseDoubleBroadcast(
  name:      string,
  channel:   PublishDeclaration | undefined,
  pipelines: Record<string, ResolvedPipeline>
): void {
  if (channel === undefined || channel === false) return
  for (const [method, p] of Object.entries(pipelines)) {
    if (!p.after?.some(isPublishHook)) continue
    throw new Error(
      `Service '${name}' declares channel: and also runs a publish() hook on '${method}'. ` +
      `Both broadcast, so every mutation would go out twice and each subscriber would apply it twice. ` +
      `Keep channel: and drop the hook, or drop channel: and keep the hook — not both.`
    )
  }
}

// A PublishDeclaration is a string, `false`, or a function — and a function
// cannot cross the wire, so describe() answers a summary rather than the value.
// `null` is a service that declares nothing, which is not the same as `false`:
// one asks the app-level default, the other refuses it.
function describeChannel(decl: PublishDeclaration | undefined): string | boolean | null {
  if (decl === undefined) return null
  if (decl === false)     return false
  return typeof decl === 'string' ? decl : true
}

// ─── The method policy (FJS-004 / FJS-D07) ────────────────────────────────
//
// A model service answers every CRUD verb through the base, WITH validation,
// whether or not the file declares one. That is opt-OUT safety with no warning:
// Basecamp's `/audit` is an append-only trail and an admin could forge a row
// into it — verified over HTTP — until four MethodNotAllowed stubs were written
// by hand. Writing those stubs is the workaround this replaces.
//
// One key, two forms:
//
//   methods: ['find', 'get']    an allow-list — the general form
//   methods: 'readOnly'         shorthand for exactly that list
//
// Absent means every method is allowed, so nothing that exists today changes.
//
// The allow-list is the general form because a narrower method set is not only
// ever "read only": `['find','get','create','approve']` says "no patch, no
// remove, one custom method", which a boolean cannot express and which otherwise goes
// back to a hand-written hook. `'readOnly'` is sugar on the same key rather than
// a second option, so there is still one place to look.

/** What `methods: 'readOnly'` expands to. */
export const READ_ONLY_METHODS: readonly string[] = ['find', 'get']

/** A service's declared method policy: an allow-list, or the one preset. */
export type MethodPolicy = string[] | 'readOnly'

/**
 * Normalise a declared policy to the set of callable method names.
 *
 * Returns `null` for "no policy declared", which is NOT the same as an empty
 * set — an empty `methods: []` is a service that answers nothing, and saying so
 * explicitly is allowed.
 *
 * `available` is every name this service could legitimately answer: CRUD plus
 * its own custom methods. A name outside it THROWS at construction rather than being
 * ignored, because the failure mode of a silent typo is the one this whole
 * feature exists to prevent — `methods: ['find', 'gett']` would block `get`
 * and read as "the allow-list is broken" only after a 405 in production.
 */
export function resolveMethodPolicy(
  policy:      MethodPolicy | undefined,
  available:   readonly string[],
  serviceName: string,
): Set<string> | null {
  if (policy === undefined) return null

  if (policy === 'readOnly') return new Set(READ_ONLY_METHODS)

  if (!Array.isArray(policy)) {
    throw new TypeError(
      `[Junction] service '${serviceName}': methods must be an array of method ` +
      `names or the string 'readOnly', got ${JSON.stringify(policy)}`
    )
  }

  const known   = new Set(available)
  const unknown = policy.filter(m => !known.has(m))
  if (unknown.length) {
    throw new TypeError(
      `[Junction] service '${serviceName}': methods lists ${unknown.map(m => `'${m}'`).join(', ')}, ` +
      `which this service does not have. Available: ${[...known].sort().join(', ')}`
    )
  }

  return new Set(policy)
}

/**
 * Every method name a service could answer — CRUD plus its own custom methods.
 *
 * Through `customMethodNames`, so a DECLARED one counts: `methods: ['find','cache']`
 * puts `cache` in the table, and validating the same list against a scan that
 * cannot see it would refuse the declaration for not matching the guess.
 */
export function serviceMethodNames(svc: object): string[] {
  return [...CRUD_METHODS, ...customMethodNames(svc)]
}

/**
 * Is this method callable on this service?
 *
 * The single predicate. `callService` enforces it and the three advertisers
 * (manifest, OpenAPI, /metrics) filter by it, so what a service answers and
 * what it says it answers cannot drift.
 */
export function isMethodAllowed(svc: object, method: string): boolean {
  const allowed = (svc as { _methods?: Set<string> | null })._methods
  return !allowed || allowed.has(method)
}

/** The callable method names, policy applied. Ordered as CRUD then custom. */
export function allowedMethodNames(svc: object): string[] {
  return serviceMethodNames(svc).filter(m => isMethodAllowed(svc, m))
}

/**
 * The one predicate for "is this a custom service method?".
 * Used by both factories to decide what to copy onto the service, and by the
 * manifest/openapi plugins to decide what to advertise.
 */
export function isCustomMethod(key: string, value: unknown): boolean {
  return typeof value === 'function'
    && !SERVICE_OPTION_KEYS.has(key)
    && !SERVICE_RUNTIME_KEYS.has(key)
}

/**
 * Custom method names found by SCANNING own keys — the fallback rule, not the
 * table. `customMethodNames` is what a built service answers with.
 */
export function scanCustomMethods(obj: object): string[] {
  return Object.keys(obj).filter(
    k => isCustomMethod(k, (obj as Record<string, unknown>)[k])
  )
}

/**
 * What `createBaseService` hands back — a service DEFINITION carrying the CRUD
 * methods, on its way into `createService`, not a built `Service`.
 *
 * The difference is load-bearing in one place: a built service's `hooks` is the
 * registration METHOD, a definition's is the MAP. Declaring this as
 * `Omit<Service, …>` therefore said the returned `hooks` was a function, and
 * the documented shape — `createService({ ...createBaseService({ model }) })` —
 * did not compile.
 */
export type BaseServiceDefinition =
  ServiceDefinition &
  Required<Pick<ServiceDefinition,
    'find' | 'get' | 'create' | 'update' | 'patch' | 'remove' | 'restore' | 'hooks'>>

export function createBaseService(
  opts: BaseServiceOptions
): BaseServiceDefinition {

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

  const { model, name, hooks, db, paginate, allowBulk, bulkMax, idField, softDelete, cache, schema, channel, methods, transactional } = opts

  const base = createLitestoneBase({
    model,
    idField,
    softDelete,
    paginate:  paginate ?? { default: 20, max: 100 },
    allowBulk: allowBulk ?? false,
    ...(bulkMax !== undefined ? { bulkMax } : {}),
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

  // Custom methods — declared by `methods:` when it is there, scanned for when it is
  // not. One parse step; everything downstream reads the table.
  const customMethods = collectCustomMethods(opts, name ?? model ?? 'service', methods)

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
  //
  // Marked as they are built, so BOTH branches of the merge below emit marked
  // hooks — an unmarked one is invisible to the dedupe and installs itself a
  // second time.
  const derived = (...fns: Hook[]): Hook[] => fns.map(markDerived)

  const derivedHooks: HookMap = {
    before: {
      find:   derived(gateAuth(model, 'read'),   autoFilter(model), autoSort(model)),
      get:    derived(gateAuth(model, 'read'),   autoFilter(model)),
      create: derived(gateAuth(model, 'create'), autoValidate(model, 'create')),
      patch:  derived(gateAuth(model, 'update'), autoValidate(model, 'patch')),
      update: derived(gateAuth(model, 'update'), autoValidate(model, 'create')),
      remove: derived(gateAuth(model, 'delete')),
    },
  }

  // User hooks run first, so a before/create hook can still shape ctx.data
  // before it is validated, and an app can add its own checks ahead of these.
  //
  // A hook map reaching here may ALREADY carry this layer: the autoloader
  // spreads a built base back through createService, and a base returns the
  // merged map, not the caller's. Appending unconditionally then ran the gate
  // and the validator twice on every request to every autoloaded service
  // (`FJS-231`). Skip a derived hook whose name is already present among the
  // MARKED hooks — a user hook of the same name is not one of ours and does not
  // suppress it.
  const mergedHooks: HookMap = hooks
    ? {
        ...hooks,
        before: (() => {
          const out: Record<string, unknown[]> = { ...(hooks.before as Record<string, unknown[]> ?? {}) }
          for (const [method, derivedForMethod] of Object.entries(derivedHooks.before!)) {
            const present = new Set(
              (out[method] ?? [])
                .filter(isDerivedHook)
                .map(h => (h as Function).name)
            )
            out[method] = [
              ...(out[method] ?? []),
              ...(derivedForMethod as unknown[]).filter(h => !present.has((h as Function).name)),
            ]
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
    // They land twice on purpose: as own keys, which is how a spread carries
    // them and how a caller reaches `svc.reboot`, and as the table, which is
    // what createService reads instead of re-scanning a shape that by then
    // includes CRUD, `_meta` and every other runtime key.
    ...customMethods,
    _customMethods: customMethods,
    ...(name    !== undefined ? { name }    : {}),
    ...(channel !== undefined ? { channel } : {}),
    // Carried through, not resolved here: the loader spreads this object into
    // createService(), which is where the allow-list is validated against the
    // custom methods that exist. Dropping it was a SECURITY-shaped silence — the same
    // `methods: 'readOnly'` that makes an audit trail append-only through
    // createService did nothing at all through createBaseService, and the only
    // symptom was a write that succeeded. Which factory you picked decided
    // whether your method policy existed, exactly as it once decided whether
    // your row policies did.
    ...(methods !== undefined ? { methods } : {}),
    // Same reason as `methods` above: createService is where the around hook is
    // installed, so a base that drops this declares a transaction nobody opens.
    ...(transactional !== undefined ? { transactional } : {}),
    hooks: mergedHooks,
    ...(cache      !== undefined ? { cache }      : {}),
    ...(allowBulk  !== undefined ? { allowBulk }  : {}),
    ...(bulkMax    !== undefined ? { bulkMax }    : {}),
    // Consumed by the openapi plugin, which prefers an explicit schema.
    ...(explicitSchemas ? { _schemas: explicitSchemas } : {}),
    // Consumed by the devtools/manifest plugins, which read service metadata.
    _meta: {
      softDelete: softDelete ?? null,
      cache:      !!cache,
      idField:    idField ?? 'id',
    },
  // Two-step because this literal is a service DEFINITION on its way into
  // createService, not a built Service: it carries no `_customMethods`, no `_methods`
  // and no `pipelines`, and those are what createService adds. A one-step
  // assertion claims an overlap the compiler is right to refuse.
  } as unknown as BaseServiceDefinition
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
  /**
   * Service name — the URL segment, and the key in the registry.
   *
   * OPTIONAL when the service is autoloaded: the loader derives it from the
   * filename ('leads.service.ts' → 'leads') and assigns it after construction.
   * Required for a service you register by hand, which has no filename to
   * derive from.
   */
  name?:      string

  /**
   * Litestone accessor — `'user'` for `model User`.
   *
   * OPTIONAL, on the same terms as createBaseService: omitted, it resolves per
   * call from the service name, so `createService({ name: 'leads' })` reaches
   * `model Lead` and `createService({})` in leads.service.ts does too.
   */
  model?:     string
  db?:        () => unknown
  paginate?:  { default: number; max: number }
  allowBulk?: boolean
  bulkMax?:   number

  /**
   * Query keys this service owns, which are NOT filters.
   *
   *   createService({ model: 'servers', reservedQuery: ['workspace_id'] })
   *   GET /servers?workspace_id=ws_7&status=live
   *     → ctx.reserved = { workspace_id: 'ws_7' }
   *     → ctx.query    = { status: 'live' }
   *
   * `$`-names are directives (Invariant 10) and everything else is graded
   * against the model's columns, so a service had no third answer: a documented
   * `?workspace_id=` fallback was refused by `autoFilter` with a 400 naming it,
   * before the hook that reads it ever ran, and the app could not fix it from
   * its own side either.
   *
   * The keys are moved off `ctx.query` in `callService`, before the pipeline —
   * so every hook, derived or the app's own, sees a query that is columns
   * alone, and every method sees the reservation in one place.
   *
   * A `$`-name is refused here, at construction, because that one is decidable
   * without a client: `$` is transport syntax and the directive table owns it.
   * A name that is also a COLUMN is refused on first use instead — the client
   * is not known when a service module is imported, so there is nothing to ask
   * at construction. It is refused rather than resolved because the two
   * readings cannot both be right, and picking one silently is how a filter
   * stops filtering.
   */
  reservedQuery?: readonly string[]

  /**
   * Narrow what this service answers. Absent = everything.
   *
   *   methods: ['find', 'get']                     an allow-list
   *   methods: 'readOnly'                          shorthand for the above
   *   methods: ['find', 'get', 'create', 'approve'] CRUD and custom together
   *
   * A method left out answers **405**, on every transport and to an in-process
   * `app.service(name).create()` alike. A name the service does not have throws
   * at construction rather than silently blocking the one you meant.
   *
   * Without this a `createService({ model })` answers every verb through the
   * base *with validation*, so a well-formed payload is written — an admin
   * could forge a row into an append-only audit trail. Opt-out safety, no
   * warning; this is the opt-in.
   */
  methods?:   MethodPolicy

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
   * Run every mutating method inside one database transaction that spans the
   * WHOLE pipeline — before hooks, the method, and the after hooks.
   *
   *   transactional: true                every mutating method
   *   transactional: ['create', 'pay']   these, named
   *
   * So an `after` hook that throws rolls the write back, instead of leaving a
   * committed row behind a rejected response. Requires a Litestone client on
   * `ctx.locals.db`; a service declaring it without one throws by name rather
   * than quietly doing nothing.
   *
   * **It does not make side effects atomic.** An email an earlier `after` hook
   * already sent stays sent — a transaction rolls back rows, not SMTP. Turning
   * the effect into a row is what makes it coverable (`FJS-089`).
   *
   * **Cost:** `BEGIN IMMEDIATE` holds SQLite's single write lock for the whole
   * pipeline, `after` hooks included, so an `after` hook doing network I/O
   * serialises every write in the app behind it. Off by default for that reason.
   */
  transactional?: TransactionalDeclaration

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
  [method: string]: ServiceDefinitionValue

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
    const rawTelemetry = ctx.app?.telemetry
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

// The hooks the FRAMEWORK installs on a model-backed service, by name.
// Exported because two tests asserted on the total length of a compiled
// `before` list and broke the day a second derived hook appeared — the count is
// a framework detail a test about USER hooks does not own. Filter by this.
export const DERIVED_HOOKS = new Set(['gateAuth', 'autoValidate', 'autoFilter', 'autoSort'])

// Stamped on a service createService has already built. Non-enumerable, so a
// spread does NOT carry it — which is the correct answer: `{...svc}` is a copy
// of the fields, not a built service, and the loader has to be able to tell.
const BUILT = Symbol.for('junction.service')

/** Has createService already built this? */
export function isBuiltService(value: unknown): boolean {
  return !!value && typeof value === 'object' && (value as Record<symbol, unknown>)[BUILT] === true
}

export function createService(def: ServiceDefinition): Service {
  // Idempotent, the way Feathers' wrapService is. Building twice would re-run
  // createBaseService and rebuild the hook state around an object that already
  // has one.
  if (isBuiltService(def)) return def as unknown as Service


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
  //
  // `model` is OPTIONAL here, exactly as it is on createBaseService: the
  // accessor resolves per call from `model ?? ctx.service`, and the service
  // name itself may be assigned by the autoloader AFTER construction. So the
  // base is built unconditionally.
  //
  // This used to read `def.model ? createBaseService(…) : notImplementedBase()`,
  // which was the same class of bug as the two above: `createBaseService({})`
  // in leads.service.ts is a complete service, while `createService({})` — or
  // `createService({ name: 'leads' })` — was a service whose every method threw
  // 'No model/db configured for this service', despite reporting
  // `model: def.model ?? def.name` on the way out. Same file, same options,
  // opposite behaviour.
  //
  // A service with no model at all (custom methods only) is unaffected: the
  // derived hooks no-op when the accessor resolves to nothing (gateAuth reads
  // null levels, autoValidate finds no definition), and calling the unused CRUD
  // methods now fails with the base's diagnostic — which names the spellings
  // tried and what the client actually has — instead of a bare sentence.
  const base = createBaseService({
    model:      def.model,
    name:       def.name,
    db:         def.db,
    paginate:   def.paginate,
    allowBulk:  def.allowBulk,
    bulkMax:    def.bulkMax,
    idField:    def.idField    as string | undefined,
    softDelete: def.softDelete as string | undefined,
    schema:     def.schema     as import('./litestone.ts').LitestoneJsonSchema | undefined,
    hooks:      def.hooks,
  })
  const baseHooks = (base as unknown as { hooks?: HookMap }).hooks

  // Reserved query keys, normalised once. A `$`-name is the one collision
  // decidable with no client: `$` is transport syntax and the directive table
  // owns every name under it (Invariant 10), so reserving one would put two
  // owners on a single spelling. The COLUMN collision is checked on first use
  // instead — there is no client here to ask.
  const reservedQuery: readonly string[] = Object.freeze([...new Set(
    ((def.reservedQuery ?? (base as { reservedQuery?: readonly string[] }).reservedQuery ?? []) as readonly string[])
      .map(k => {
        if (typeof k !== 'string' || !k.trim())
          throw new Error(`createService(${def.name ?? '?'}): reservedQuery takes non-empty strings`)
        if (k.startsWith('$')) throw new Error(
          `createService(${def.name ?? '?'}): cannot reserve '${k}' — a $-name is a directive, ` +
          `and @frontierjs/toolbelt/directives is its one owner. Reserve a name without the $.`)
        return k
      }))])

  // `def.name` is optional in the type because the autoloader assigns it after
  // construction ('leads.service.ts' → 'leads'). Everything below that needs a
  // string reads this. A hand-registered service without a name is the one case
  // this cannot cover — the registry would key it on undefined — so the loader
  // fills it in before register() is reached.
  const defName = def.name as string

  const hookMaps: HookMap[] = []

  // ── Cache hook injection ──────────────────────────────────────────────────
  // Split into two pushes so ordering is correct:
  //   before pipeline: [checkCache, ...userBeforeHooks]  — short-circuits early
  //   after  pipeline: [...userAfterHooks, storeResult]  — stores final result
  //   after  pipeline: [...userAfterHooks, bustCache]    — busts after all transforms
  let cacheHooks: ReturnType<typeof buildCacheHooks> | null = null
  if (def.cache) {
    cacheHooks = buildCacheHooks(defName, def.cache)
    // Push before-cache hooks FIRST — checkCache must run before user hooks
    hookMaps.push({
      before: {
        find: [cacheHooks.checkCache],
        get:  [cacheHooks.checkCache],
      },
    })
  }

  if (def.hooks) {
    // An anonymous hook shows as 'anonymous' in the telemetry waterfall, which
    // is worth saying — once. It used to print a full sentence per PHASE per
    // METHOD, so a service with one inline hook on `all` and five methods
    // produced five identical lines, and an app produced dozens before it had
    // served anything. That is a style note competing with real warnings for the
    // same scrollback.
    //
    // Now: one line per service, naming the positions, and only under DEBUG=1.
    // Nothing is lost — the count and the positions are what a person acts on,
    // and the advice is the same for all of them.
    if (isDiagnosticMode()) {
      const positions: string[] = []
      for (const phase of ['before', 'after', 'around', 'error'] as const) {
        const phaseHooks = def.hooks[phase]
        if (!phaseHooks) continue
        for (const [method, hooks] of Object.entries(phaseHooks)) {
          if (!Array.isArray(hooks)) continue
          for (const hook of hooks)
            if (typeof hook === 'function' && !hook.name) positions.push(`${phase}.${method}`)
        }
      }
      if (positions.length)
        diagnostic(
          `[Junction] ${positions.length} anonymous hook(s) on ${def.name} ` +
          `(${positions.join(', ')}) — name them for telemetry`
        )
    }
  }
  // base.hooks already contains def.hooks merged with the derived hooks —
  // push it (not def.hooks) so both layers survive. The `?? def.hooks` is a
  // belt-and-braces fallback: createBaseService always returns a hooks map now
  // that the base is built unconditionally.
  const effectiveHooks = baseHooks ?? def.hooks
  if (effectiveHooks) hookMaps.push(effectiveHooks)

  // Pushed LAST of the service's own layers so it is the innermost service-level
  // around hook — outside every before/after hook it must cover, inside the
  // app-level withLitestoneDb that scopes the client it opens the transaction on.
  if (def.transactional !== undefined && def.transactional !== false) {
    hookMaps.push({ around: { all: [transactionScopeHook(defName ?? '(unnamed)', def.transactional)] } })
  }

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

  // ── The pipeline, and its one owner ───────────────────────────────────────
  //
  // Memoised on BOTH inputs: the app's hook map by identity, and the service's
  // own by a version that `hooks()` bumps. That is what makes staleness
  // impossible rather than remembered — there used to be a `_compiledPipelines`
  // cache with four writers, a hand invalidation, a registry that monkey-patched
  // `hooks()` to recompile, and a three-way ladder in callService where the
  // cache beat the app hooks the transport had just handed over. A stale entry
  // was therefore a wrong answer, not a slow one.
  //
  // `app.hooks()` REASSIGNS app._appHooks to a fresh map rather than mutating
  // it, so identity is a sound key. Anything that starts mutating it in place
  // silently defeats this.
  let hookVersion = 0
  let memoKey:     HookMap | null = null
  let memoVersion  = -1
  let memo:        Record<string, ResolvedPipeline> | null = null

  function pipelinesFor(appHooks?: HookMap | null): Record<string, ResolvedPipeline> {
    const key = appHooks ?? null
    if (memo && memoVersion === hookVersion && memoKey === key) return memo
    memoKey     = key
    memoVersion = hookVersion
    memo = resolvePipelines(key ? mergeHookMaps(key, mergedMap) : mergedMap)
    refuseDoubleBroadcast(defName, def.channel as PublishDeclaration | undefined, memo)
    return memo
  }

  const service: Service = {
    name:  defName,
    model: def.model ?? def.name,
    // Seeded empty and REPLACED below, once collectCustomMethods has resolved the
    // table off the built object. Declared here because Service requires it and
    // a literal that omits it is not one.
    _customMethods: {},
    // Carried through so callService can find it after the pipeline. Reserved
    // in SERVICE_OPTION_KEYS, so a function form never becomes a custom method.
    ...(def.channel !== undefined ? { channel: def.channel as PublishDeclaration } : {}),
    // Same reason: declared, honoured internally, but previously not carried
    // onto the built service, so anything reading it back saw undefined.
    allowBulk: def.allowBulk ?? (base as { allowBulk?: boolean }).allowBulk ?? false,
    bulkMax:   def.bulkMax   ?? (base as { bulkMax?: number }).bulkMax   ?? 1000,
    ...(reservedQuery.length ? { reservedQuery } : {}),

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
    _find:    makeBypass(defName, 'find',    def.find    ?? base.find),
    _get:     makeBypass(defName, 'get',     def.get     ?? base.get),
    _create:  makeBypass(defName, 'create',  def.create  ?? base.create),
    _update:  makeBypass(defName, 'update',  def.update  ?? base.update),
    _patch:   makeBypass(defName, 'patch',   def.patch   ?? base.patch),
    _remove:  makeBypass(defName, 'remove',  def.remove  ?? base.remove),
    _restore: makeBypass(defName, 'restore', (def.restore ?? base.restore) as (ctx: ServiceContext) => Promise<unknown>),

    // Push, merge, bump. One merge and no resolve — the resolve happens on the
    // next read, for whichever app hooks that read carries. Nothing here has to
    // remember to invalidate anything.
    hooks(map: HookMap): void {
      hookMaps.push(map)
      mergedMap        = mergeHookMaps(...hookMaps)
      service._hookMap = mergedMap
      hookVersion++
    },

    pipelines: pipelinesFor,

    describe(): ServiceDescription {
      const meta = ((service as unknown as { _meta?: Record<string, unknown> })._meta) ?? {}
      const schemas = (service as unknown as { _schemas?: { create?: unknown; patch?: unknown } })._schemas
      return {
        name:       service.name,
        model:      service.model ?? service.name,
        customMethods: customMethodNames(service),
        // Policy applied: advertising a verb the service answers 405 to is
        // worse than not advertising it, because a generated client calls it.
        methods:    allowedMethodNames(service),
        allowBulk:  !!service.allowBulk,
        bulkMax:    service.bulkMax ?? 1000,
        reservedQuery: [...(service.reservedQuery ?? [])],
        softDelete: (meta.softDelete as string | null) ?? null,
        cache:      !!meta.cache,
        idField:    (meta.idField as string) ?? 'id',
        transactional: [...(service._transactional ?? [])],
        channel:    describeChannel(service.channel as PublishDeclaration | undefined),
        hooks:      service._hookMap,
        ...(schemas ? { schemas } : {}),
      }
    },

    _hookMap: mergedMap,

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

  // The custom methods, resolved once. A base reached through the loader's spread has
  // already built its own table and put it on `def`; taking that over rescanning
  // matters because by then `def` also carries CRUD, the bypass twins and
  // `_meta`, and the scan would have to be right about all of them again.
  const custom: CustomMethodMap = {
    ...((def as { _customMethods?: CustomMethodMap })._customMethods ?? {}),
    ...collectCustomMethods(def, defName ?? '(unnamed)', def.methods),
  }

  // On the object as well as in the table: a spread has to carry them, and
  // `svc.reboot` is a shape callers already use.
  for (const [key, fn] of Object.entries(custom)) {
    (service as unknown as Record<string, unknown>)[key] = fn
  }
  ;(service as Service)._customMethods = custom

  // Resolve the method policy AFTER the custom methods are on, because an allow-list
  // may name one and the unknown-name check has to be able to see it.
  ;(service as Service)._methods = resolveMethodPolicy(
    def.methods,
    serviceMethodNames(service),
    defName ?? '(unnamed)',
  )

  // Resolved for describe() only — the hook itself filters at call time. Read
  // off the policy so the answer is what the service will actually answer.
  ;(service as Service)._transactional = resolveTransactional(
    def.transactional,
    [...((service as Service)._methods ?? serviceMethodNames(service))],
  )

  Object.defineProperty(service, BUILT, { value: true, enumerable: false })

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
    // Warm every registered service so the first request after start() does not
    // pay for the resolve. A warm, not a write: the service owns its own memo
    // and keys it on both inputs, so warming the wrong thing is impossible
    // rather than merely unlikely.
    this._warmAll()
  }

  private _warmAll(): void {
    if (!this._appHooks) return
    for (const svc of this._map.values()) svc.pipelines(this._appHooks)
  }

  register(service: Service): void {
    this._map.set(service.name, service)
    // Registered after start() — warm it here so it is on the same footing as
    // everything registered before. This used to also monkey-patch hooks() on
    // the instance, because a late svc.hooks() left a compiled cache that
    // silently outranked it; the version key in pipelines() is what removed the
    // need, and with it the double merge-and-resolve every hooks() call paid.
    if (this._appHooks) service.pipelines(this._appHooks)
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

// (notImplementedBase removed: createService builds the real base
// unconditionally, since the accessor resolves per call from
// `model ?? ctx.service`. Its stand-in methods threw
// 'No model/db configured for this service' for every service that omitted
// `model` — including ones whose model was perfectly resolvable from the name.)

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
 *
 * A service declaring NOTHING falls through to the app-level default
 * (`app.channels.publishDefault(fn)`), which is null unless an app registered
 * one — so the opt-in above is unchanged, and an app that wants one scoping
 * rule for twenty services writes it once (FJS-334). `channel: false` is the
 * declared opt-out and is not asked; it means this service broadcasts nothing,
 * default included.
 */
async function publishToChannels(
  service: Service,
  ctx:     ServiceContext,
  event:   string,
  payload: unknown
): Promise<void> {
  const decl = service.channel as PublishDeclaration | undefined
  if (decl === false) return

  const manager = ctx.locals.__channels as {
    channel:  (name: string) => unknown
    publish:  (event: string, data: unknown, ctx: ServiceContext, fn: (d: unknown, c: ServiceContext) => unknown) => Promise<void>
    defaultPublisher?: ((data: unknown, ctx: ServiceContext) => unknown) | null
  } | undefined
  if (!manager) return

  // The manager has to be resolved before this question can be asked, which is
  // why the undefined case is not an early return beside `false` any more.
  const target = decl ?? manager.defaultPublisher ?? undefined
  if (target === undefined || target === null) return

  const resolve = typeof target === 'string'
    ? () => manager.channel(target)
    : target

  try {
    await manager.publish(event, payload, ctx, resolve as never)
  } catch {
    // A broadcast failure must not fail the write. The record is already
    // committed; a dead socket is not the caller's problem.
  }
}

// (parseSortParam / parseSelectParam removed — the merged base delegates
// query parsing to litestone.ts's parseSort / parseSelect, one dialect.)
