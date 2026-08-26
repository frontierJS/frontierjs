// core/context.ts
// The framework's central call-context types — OWNED BY CORE.
//
// ServiceContext is what every hook and service method sees, on every
// transport and on internal calls. It used to live in transport/bridge.ts,
// which inverted the layering: the service layer's own vocabulary was
// defined by (and imported from) a transport module. Core modules now
// import these from here; transport/bridge.ts re-exports everything for
// backwards compatibility, so existing `from '.../transport/bridge.ts'`
// imports keep working.
//
// The one remaining upward reference is $raw's TransportContext type — a
// type-only escape hatch (erased at compile time, no runtime coupling).

import { AsyncLocalStorage } from 'node:async_hooks'
import type { FrameworkError } from './errors.ts'
import type { SessionContext } from '../auth/types.ts'
import type { QueryDirectives, Page } from './directives.ts'
// A value import, and outbox.ts imports only TYPES back — so the cycle is
// erased at compile time and there is none at runtime.
import { enqueueOutbox } from './outbox.ts'

// ─── Context shape ────────────────────────────────────────────────────────
// Single object throughout the pipeline (around → before → method → after
// → error). There is NO separate HookContext — one shape, ctx.type says
// which phase.

export interface ServiceContext {
  // ── routing ──────────────────────────────────────────────────────────
  service:   string
  method:    AnyMethod     // 'find'|'get'|'create'|'update'|'patch'|'remove'|'restore'|custom
  type:      HookType      // set by hook pipeline
  transport: 'http' | 'websocket' | 'internal'
  model:     string        // set by createService from ServiceDefinition.name

  // ── call inputs ───────────────────────────────────────────────────────
  id:    string | number | null

  /**
   * FILTERS ONLY — which records. Becomes the WHERE clause.
   *
   * `$`-prefixed keys never appear here. They are wire syntax, translated by
   * the bridge into `directives` below; nothing inside the framework reads a
   * `$`. That separation is not cosmetic — conflating the two is what made
   * `?limit=1` a filter on a column named "limit" (returning zero rows, no
   * error) while `?$limit=1` did nothing at all.
   */
  query: Record<string, unknown>

  /**
   * DIRECTIVES — how to shape the result. Never filters.
   *
   * Structured, unprefixed, and the only thing the query builder reads. The
   * bridge fills this from `$limit`/`$offset`/`$orderBy`/`$select`/… on the
   * wire; internal callers set it directly:
   *
   *   app.service('posts').find({ status: 'open' }, { limit: 10 })
   *
   * Populated on every call — `{}` when the caller asked for nothing.
   */
  directives: QueryDirectives

  data:  Record<string, unknown> | Record<string, unknown>[] | null

  // ── auth: WHO is calling — the principal only. Frozen. PROPAGATES
  // across internal calls (carry caller identity so authz stays
  // consistent). Nothing environmental lives here.
  auth: {
    user: import('../auth/types.ts').SessionContext | null
  }

  // ── client: caller environment. Read-only. Propagates. {} on
  // internal calls (no real client). ip / user-agent / raw headers.
  client: {
    ip?:        string
    userAgent?: string
    headers:    Record<string, string>
    [key: string]: unknown
  }

  // ── route: path-pattern captures (:id, :room). Distinct from
  // ctx.id (the resource id). Router-only; {} on internal calls.
  route: Record<string, string>

  // ── locals: per-call scratch. FRESH {} every call. Does NOT
  // propagate across internal calls — a sub-service mutating
  // ctx.locals physically cannot reach its caller. Written in
  // around/before, read in method/after. Plugins augment
  // ServiceContextLocals.
  locals: ServiceContextLocals

  /**
   * The @transient keys of this call's payload — accepted on the wire, stored
   * nowhere.
   *
   * A model declares `secret String? @transient`; `autoValidate` validates the
   * value like any other field and then moves it here, so the write never
   * carries it and a method body has one place to look. `{}` on a service whose
   * model declares none.
   *
   * FRESH {} every call and does NOT propagate, on the same terms as locals.
   * Separate from locals because the framework writes this one: it is call
   * INPUT that the caller sent, the way `directives` is the input the bridge
   * parsed off `$`-params, and locals is the bag a hook keeps its own working
   * state in.
   *
   * A bulk write carrying one is refused rather than lifted — the value is
   * about one call, and the rows a service receives are the ones that passed
   * validation, so an index-aligned array would pair one row's value with
   * another row.
   */
  transients: Record<string, unknown>

  /**
   * The query keys this service RESERVED — sent by the caller, never a filter.
   *
   * A service declares `reservedQuery: ['workspace_id']`; `callService` moves
   * those keys here before any hook runs, so `ctx.query` is columns alone by
   * the time `autoFilter` grades it and by the time a hook builds a where. `{}`
   * on a service that declares none.
   *
   * The query-side mirror of `transients`, and it exists for the same reason:
   * `$`-names are directives (Invariant 10) and everything else is a column, so
   * a service had no way to say *this key is mine* — basecamp's documented
   * `?workspace_id=` fallback was refused with a 400 naming it before the hook
   * that reads it ever ran.
   *
   * FRESH {} every call and does NOT propagate, on the same terms as locals.
   */
  reserved: Record<string, unknown>

  // ── app reference ─────────────────────────────────────────────────────
  app: import('./app.ts').App

  // ── lifecycle ─────────────────────────────────────────────────────────
  /**
   * `null` until the method has run; a `ServiceResult` envelope after it; and
   * whatever a short-circuiting `before` hook assigned, which the framework
   * passes through untouched (a cache hit, a `Response`, a bare string).
   *
   * Typed `unknown` because the envelope is only one of those three, and
   * declaring it as the envelope alone made every honest assignment a cast —
   * including two of the framework's own. Read the rows out with
   * `resultData(ctx.result)` and the whole answer with `unwrapResult()`.
   */
  result:  unknown
  error:   FrameworkError | null

  // ── HTTP-specific ─────────────────────────────────────────────────────
  statusCode?: number          // override HTTP status
  dispatch?:   unknown | false // separate payload for real-time broadcast; false = suppress

  // escape hatch — never use in services or hooks (type-only upward ref)
  $raw: import('../transport/types.ts').TransportContext | null

  /**
   * Run this AFTER the call has succeeded — and, where the service declares
   * `transactional:`, after the transaction has committed.
   *
   * The phase an `after` hook is not. Hooks run in sequence, so an `after` hook
   * that sends an email runs and a later one throwing makes the call report
   * failure with the email already gone; under `transactional:` the write is
   * rolled back and the email is still gone. Rails states the choice as
   * `after_save` vs `after_commit`, and this is the second one (`FJS-089`).
   *
   *   ctx.afterCommit(() => app.conduit.send('order.shipped', { to, order }))
   *
   * **Observer tier** (`FJS-D06`): the call has already succeeded and been
   * announced, so a callback cannot halt it and a throw cannot be reported as
   * the call failing — turning a post-commit failure into a 500 would tell the
   * client a write failed that did not. A throw is caught, logged loudly and
   * emitted as `junction.aftercommit.error`.
   *
   * **Not durability.** A crash between the commit and the callback loses the
   * effect; nothing is recorded anywhere. For an effect that must survive that,
   * write a row inside the transaction and let something else deliver it.
   *
   * Assigned by `callService`, so it exists on every context a hook can hold.
   */
  afterCommit: (fn: () => void | Promise<void>) => void

  /**
   * Record a durable effect — the half `afterCommit` is not.
   *
   * Writes a row into the app's own database INSIDE this call's transaction,
   * so the intent is recorded if and only if the write it belongs to
   * committed. A relay then hands it to `app.jobs` and marks it delivered, so
   * a crash anywhere in between costs a delay rather than the effect.
   *
   *   await ctx.enqueue('order.shipped', { orderId: row.id })
   *
   * A NAME and a PAYLOAD, where `afterCommit` takes a function — which is the
   * whole reason these are two verbs and not one verb with a flag. A closure
   * cannot be written to a table, so anything that must survive the process
   * has to be addressed by name; the API says so rather than letting the first
   * crash say it.
   *
   * Awaited, and it refuses by name rather than degrading: outside a
   * transaction, without the model, or with no relay installed, a row would be
   * either meaningless or undeliverable. `FJS-D35`.
   */
  enqueue: (job: import('./outbox.ts').EnqueueRef, payload: unknown,
            opts?: import('./outbox.ts').EnqueueOptions) => Promise<string>

  // instrumentation — set by callService, undefined for bypass (_find etc.)
  telemetryId?: string

  // cleanup callbacks — called in callService finally block after pipeline
  // completes. Used by litestone $tapQuery teardown and any other
  // per-request teardown. NOT scratch — framework-internal.
  _cleanups?: Array<() => void>

  // what ctx.afterCommit() queued. Drained by callService, once, on success.
  // NOT scratch — framework-internal.
  _afterCommit?: Array<() => void | Promise<void>>

  // outbox rows this call wrote. Only to tell callService whether kicking the
  // relay is worth it — the rows are committed and the sweep would find them
  // anyway. NOT scratch — framework-internal.
  _outbox?: string[]
}

/**
 * Give a context the two effect verbs, and hand it back complete.
 *
 * One implementation and four callers: the two builders in `bridge.ts`, the
 * internal one in `app.ts`, and `callService`, which calls it for any context
 * that arrived without them — a hand-built context in a test still has to be
 * able to run a hook that queues an effect.
 *
 * The argument is the context MINUS what this adds, so a builder's object
 * literal is still checked against every other field it owes.
 */
export function withCallEffects(
  base: Omit<ServiceContext, 'afterCommit' | '_afterCommit' | 'enqueue' | '_outbox'>
): ServiceContext {
  const queued: Array<() => void | Promise<void>> = []
  const ctx = base as ServiceContext
  ctx._afterCommit = queued
  ctx.afterCommit  = (fn) => { queued.push(fn) }
  ctx.enqueue = (job, payload, opts) => enqueueOutbox(ctx, job, payload, opts)
  return ctx
}

// Per-call scratch. Plugins augment via `declare module`. Core leaves
// it open. (Named `locals` — not `state` — to avoid the ElysiaJS
// collision where `state` means app-global shared; `locals` has the
// Astro/SvelteKit per-request meaning we want.)
export interface ServiceContextLocals {
  /** `Page`, not a restatement of it — `paginate()` and `parseQuery` both
   *  answer the same shape through `clampPage`, and a third spelling here is
   *  how the hook and the query builder came to disagree in the first place. */
  paginate?: Page
  [key: string]: unknown
}

// ─── Query directives ─────────────────────────────────────────────────────
// Declared in core/directives.ts — a module that imports nothing, so the
// browser client can name the same fields without dragging
// node:async_hooks into a bundle. Re-exported here because this is where the
// API realm has always found it.

export type { QueryDirectives, Page } from './directives.ts'

// ─── Hook type ────────────────────────────────────────────────────────────
// `method` is the phase where the service method itself runs. It is not a hook
// slot anyone registers into, but `runPipeline` DOES set `ctx.type = 'method'`
// while the method executes, so a hook or an `around` reading `ctx.type` can
// legitimately see it. Leaving it out of the union made the assignment a type
// error inside the pipeline and a lie to everyone reading it.
export type HookType = 'before' | 'validated' | 'method' | 'after' | 'around' | 'error'

// ─── Result envelope ──────────────────────────────────────────────────────
// Owned by core/envelope.ts — the single module that builds, inspects and
// unwraps it. Re-exported here so `from '.../core/context.ts'` and
// `from '.../transport/bridge.ts'` imports keep working.
export type { ServiceResult, ResultKind, ListResult, SingleResult } from './envelope.ts'

export type ServiceMethod = 'find' | 'get' | 'create' | 'update' | 'patch' | 'remove' | 'restore'
export type AnyMethod     = ServiceMethod | string

// ─── Call options (internal service-to-service calls) ─────────────────────
export interface CallOptions {
  // Run as this principal. Default: system (null user). Pass ctx.auth
  // to propagate the caller's identity so authz stays consistent.
  auth?: { user: import('../auth/types.ts').SessionContext | null }

  // Provenance. Default 'internal'. Hooks branch on this — a re-entrant
  // 'http'-flagged call fires webhooks/notifications; a plain
  // 'internal' call is background work that shouldn't.
  transport?: 'http' | 'websocket' | 'internal'

  // Explicitly seed the callee's scratch. RARE. The one real use: pass
  // a db transaction handle so the sub-call runs in the same tx.
  locals?: Partial<ServiceContextLocals>

  /**
   * Result-shaping directives — limit, offset, orderBy, select, …
   *
   * Internal callers had no way to express these at all: CallOptions carried
   * only auth/transport/locals, and the `$`-prefixed spellings lived on the
   * wire. `app.service('posts').find({}, { limit: 10 })` was simply ignored.
   */
  directives?: QueryDirectives
}

// ─── Reserved query params ────────────────────────────────────────────────
// Stripped from ctx.query before reaching Litestone / service methods, so a
// directive can never be mistaken for a column filter. $first and $wrap are
// transport-only and have no structured form.
//
// The table is `@frontierjs/toolbelt/directives`, because Sierra's router reads
// the same grammar off a URL's search string — two boundaries, one convention,
// and a key only one of them knows about becomes a WHERE clause on a column
// nobody declared. Re-exported here because this is where the API realm has
// always found it.
export { RESERVED_PARAMS } from '@frontierjs/toolbelt/directives'

// ─── Request-wide metadata (AsyncLocalStorage) ────────────────────────────
// Correlation id, idempotency key, locale belong to the WHOLE request,
// not any single call. They ride an ALS store the bridge wraps the
// pipeline run in. Read anywhere, any depth, via requestMeta().

export interface RequestMeta {
  correlationId:   string
  idempotencyKey?: string
  locale?:         string
  origin:          'http' | 'websocket' | 'internal'

  /**
   * WHO the request is on behalf of — the principal, request-wide.
   *
   * `ctx.auth.user` is the per-call view of this. It lives here because
   * identity belongs to the request rather than to any one call in it, which
   * is what makes it propagate: an internal call that names no principal
   * inherits this one, at any depth, through a hook or a fan-out or a
   * sub-service three levels down.
   *
   * Before this, `ctx.auth` was built from `opts.auth` alone and nothing
   * else — so `ctx.app.service('inner').find()` from inside a service ran as
   * STRANGER(0) while `context.ts` documented auth as propagating. Measured:
   * the inner service saw `null`.
   *
   * **Absent is not null.** A caller passing `{ auth: { user: null } }` means
   * *as nobody* and keeps it; a caller passing no `auth` at all means *say
   * nothing*, and inherits. Same distinction Invariant 9 makes about a patch,
   * one realm over — and it is what lets a service deliberately read as an
   * anonymous caller would.
   */
  user?:           import('../auth/types.ts').SessionContext | null

  /**
   * WHERE the request came from — `ip`, `userAgent`, `headers`.
   *
   * Request-wide for the same reason `user` is, and it propagates the same
   * way: an audit hook three calls deep needs the IP of the request that
   * caused the write, and there is no other route to it. It is information,
   * never authority — nothing in the framework grades a caller by it.
   */
  client?:         { ip?: string; userAgent?: string; headers: Record<string, string>; [k: string]: unknown }

  /**
   * WHICH TENANT the work is for, where the app declares tenancy.
   *
   * Request-wide because a tenant is a property of the work and not of any one
   * call in it, and because the readers that need it most hold no `ctx`: a job
   * running an hour later, an outbox relay, a cache key. A transport that has
   * a request resolves the tenant from it and the answer lands on
   * `ctx.locals.tenantId`; this is the other direction — work with no request
   * behind it STATES its tenant here, and `withTenantDb` reads it.
   *
   * It is a pointer to a set of rows and never an authority. Whoever the work
   * runs as is still re-resolved and still graded; naming a tenant decides
   * which rows are in scope and nothing about who may touch them.
   */
  tenant?:         string | null
}

const _requestStore = new AsyncLocalStorage<RequestMeta>()

// The one call that opens the store. Everything else goes through
// enterRequest()/reenterAs() below, which is what makes those two the only
// place a RequestMeta is ever built.
function open<T>(meta: RequestMeta, fn: () => T): T {
  return _requestStore.run(meta, fn)
}

// ─── Entering the request scope — the ONE owner ───────────────────────────
//
// Five entry points establish a request: the HTTP handler, the WebSocket
// frame dispatcher, app.runAs(), a service call that arrives with no store at
// all (a job, a script, a boot task), and the test harness. Each of them used
// to build a RequestMeta literal by hand, and the five copies were not the
// same: the socket path wrapped nothing for its whole life, so requestMeta()
// was undefined for every WS call and the Idempotency-Key that decides
// whether a create runs twice applied to half the transports; the test
// harness dropped `user` and `client` on the floor, so propagation behaved
// one way under test and another in production.
//
// So the meta is built HERE and nowhere else, and a transport hands over what
// it has rather than what the shape needs. A sixth transport cannot forget a
// field it never names.
export interface RequestSource {
  origin: RequestMeta['origin']

  /**
   * The request's own headers, where there are any.
   *
   * Three keys are read off them and this is the only place that knows which:
   * `x-request-id`, `idempotency-key`, `accept-language`. A transport with no
   * headers (a job, a script) states the values it has instead.
   */
  headers?: Record<string, string | undefined>

  /** Stated explicitly. Wins over `headers` — a transport that already
   *  resolved a correlation id of its own is not overruled by a header. */
  correlationId?:  string
  idempotencyKey?: string
  locale?:         string

  /** WHO and WHERE. Both propagate; see the doc on RequestMeta. */
  user?:   RequestMeta['user']
  client?: RequestMeta['client']

  /** WHICH TENANT, for work that has no request to resolve one from. */
  tenant?: RequestMeta['tenant']
}

export function enterRequest<T>(src: RequestSource, fn: () => T): T {
  const h = src.headers
  return open({
    correlationId:  src.correlationId  ?? h?.['x-request-id'] ?? crypto.randomUUID(),
    idempotencyKey: src.idempotencyKey ?? h?.['idempotency-key'],
    locale:         src.locale         ?? h?.['accept-language']?.split(',')[0]?.trim(),
    origin:         src.origin,
    user:           src.user,
    client:         src.client,
    tenant:         src.tenant,
  }, fn)
}

/**
 * Re-establish the scope because THIS call's principal differs from the one
 * already in it — service A running as alice calling B as bob, where anything
 * B calls must inherit bob.
 *
 * Not merged into enterRequest() because it is the other question: that one
 * says *a request starts here*, this one says *the same request, someone
 * else*. Everything but the principal is carried over, which is the whole
 * difference — a correlation id that changed mid-request is a broken trace.
 *
 * A call whose principal is already the one in scope opens NOTHING: on the
 * common path the two are the same object by construction, and an ALS run()
 * per service call would be paid by every nested call in the app to change
 * nothing. A call arriving with no store at all is an entry point of its own
 * and gets an internal request, which is what gives background work a
 * principal to propagate at all.
 */
export function reenterAs<T>(user: RequestMeta['user'], fn: () => T): T {
  const scoped = _requestStore.getStore()
  if (!scoped) return enterRequest({ origin: 'internal', user }, fn)
  if (scoped.user === user) return fn()
  return open({ ...scoped, user }, fn)
}

// The accessor authors use. Returns undefined outside a request
// (e.g. during boot / service init).
export function requestMeta(): RequestMeta | undefined {
  return _requestStore.getStore()
}

// ─── `$` — the service call you are inside ────────────────────────────────
//
// A request is one thing; a CALL inside it is another. `ctx.auth` and
// `ctx.client` belong to the request and ride RequestMeta above. `ctx.data`,
// `ctx.id`, `ctx.locals` and `ctx.locals.db` belong to one invocation: fresh
// per call, and `transactional:` swaps the db under the method mid-call. So
// this is a second store with a second span, and NOT the announcing-service
// store below — that one is deliberately narrower, because widening it would
// stop a write inside an afterCommit effect from being announced.
//
// The span is the whole of _callService: the method policy, the idempotency
// claim, the pipeline, the announcement, the afterCommit drain, the outbox
// handoff. Everything that semantically belongs to this invocation. A nested
// call runs this again with its own context, so `$` inside it is the inner
// call and the outer one is untouched when it returns.
//
// A replayed idempotent call returns before any of that: it runs no hook and
// no method, so there is no user code to read `$` and nothing is owed.

const _callStore = new AsyncLocalStorage<ServiceContext>()

export function enterCall<T>(ctx: ServiceContext, fn: () => T): T {
  return _callStore.run(ctx, fn)
}

/** The context of the call in progress, or undefined outside one. */
export function currentCall(): ServiceContext | undefined {
  return _callStore.getStore()
}

/**
 * `$` reads the call in progress. Two rules make it safe to be this broad:
 *
 *   NO INVENTED KEYS. Only junction's own contract properties can be assigned
 *   (WRITABLE below) — `$.dispatch = false` works, `$.myThing = 1` throws. What
 *   makes an ambient object dangerous is that anyone can keep state on it, not
 *   that it can be written at all: a fixed list cannot grow, so it is not a
 *   bag. Per-call state is `$.locals`, app state is `app.claim()` (Invariant 5).
 *
 *   CALL LIFETIME. Outside a call it throws by name rather than answering
 *   undefined. An ambient dependency is an undeclared one — `steps(id)` does
 *   not say in its signature that it needs a call — and the whole of what
 *   makes that acceptable is that the failure is loud, immediate and names
 *   itself. Answering undefined would trade a loud bug for a silent one,
 *   which is the trade this exists to reverse.
 *
 * Resolved on every property read, never snapshotted: `transactional:` sets
 * `ctx.locals.db = tx` before running the method, so a value captured earlier
 * is the wrong client.
 */
export type CallContext = ServiceContext & {
  /** `ctx.locals.db` — the caller-scoped Litestone client. */
  readonly db: NonNullable<ServiceContextLocals['db']>
  /** `ctx.auth.user` — the principal this call is running as. */
  readonly me: ServiceContext['auth']['user']
  /**
   * What this app is configured with, FOR THIS CALL.
   *
   * A read-only view over `app.config`, resolved through the one owner
   * (`core/config-scope.ts`) rather than reached for directly — so a value that
   * becomes per-tenant later becomes per-tenant for every reader at once,
   * instead of needing every reader found again (`FJS-D126`).
   *
   * Today it is `app.config`, for every caller, identically. Reading it is a
   * statement about WHEN the value is read and none at all about what it is.
   */
  readonly config: import('../config/index.ts').AppConfig
}

function held(key: string | symbol): ServiceContext {
  const ctx = _callStore.getStore()
  if (ctx) return ctx
  throw new Error(
    `[Junction] '$' was read outside a service call (reading '${String(key)}').
` +
    `'$' is the context of the service call in progress, so it exists inside a ` +
    `service method, a hook, an afterCommit effect, and anything they call — and ` +
    `nowhere else. At module scope it runs at import, before any call exists.
` +
    `From a job, a script or a boot task, go through a service ` +
    `(app.service('x').find()) or take the ctx parameter.`
  )
}

// The properties a service or a hook is MEANT to assign — junction's own
// contract, and nothing else. `$` refuses every other key, which is the whole
// of the read-only rule: what makes an ambient object dangerous is that anyone
// can invent a key on it and keep state there, not that it can be written at
// all. A fixed contract list cannot grow, so it is not a bag.
//
// Without this, `ctx.dispatch = false` — the documented way for a read-shaped
// custom method to say "do not broadcast this" — had no spelling on `$`, and
// eighteen call sites in one app had to keep taking a context for it.
const WRITABLE = new Set(['data', 'query', 'id', 'result', 'error', 'statusCode', 'dispatch'])

const NOT_WRITABLE = (key: string | symbol) =>
  `[Junction] '$.${String(key)}' cannot be assigned. A service may set ` +
  `${[...WRITABLE].join(', ')} — everything else is a view of the call, not a ` +
  `place to keep state: use $.locals for one call, or app.claim() for the app.`

export const $: CallContext = new Proxy({} as CallContext, {
  get(_t, key) {
    // A context is not a promise. Left to fall through, `await $` and every
    // library that probes for a thenable would resolve it to something else.
    if (key === 'then') return undefined
    if (key === 'db') {
      const db = held(key).locals.db
      if (!db) throw new Error(
        `[Junction] '$.db' — this call has no Litestone client on ctx.locals.db. ` +
        `Build the app with createApp({ db }) or createApp({ tenants }).`
      )
      return db
    }
    if (key === 'me') return held(key).auth.user
    if (key === 'config') {
      const app = (held(key) as { app?: { configFor?: (t: string | null) => unknown } }).app
      if (!app?.configFor) throw new Error(
        `[Junction] '$.config' — this call has no app on it. A hand-built context ` +
        `passed to a method directly carries no app; call through app.service(name) ` +
        `or use app.configFor() where you hold the app.`
      )
      return app.configFor(held(key).locals?.tenantId ?? null)
    }
    // Symbols are protocol, not data — inspection and toString must not throw
    // outside a call, or a logger printing `$` becomes the error.
    if (typeof key === 'symbol') return _callStore.getStore()?.[key as never]
    return held(key)[key as keyof ServiceContext]
  },

  set(_t, key, value) {
    if (typeof key === 'string' && WRITABLE.has(key)) {
      (held(key) as unknown as Record<string, unknown>)[key] = value
      return true
    }
    throw new Error(NOT_WRITABLE(key))
  },
  defineProperty(_t, key) { throw new Error(NOT_WRITABLE(key)) },
  deleteProperty(_t, key) { throw new Error(NOT_WRITABLE(key)) },

  has(_t, key) {
    if (key === 'db' || key === 'me' || key === 'config') return true
    return key in held(key)
  },

  // Destructuring, spread and Object.keys() go through these, and they answer
  // the CONTEXT's own keys only.
  //
  // `db`, `me` and `config` are deliberately absent: they are derived accessors,
  // not data, and enumerating them makes a spread EVALUATE them — so `{ ...$ }`
  // on an app with no Litestone client threw the "no client on ctx.locals.db"
  // error from inside a spread that never asked for a db. They stay reachable
  // by name through get() and `in`, which is what an accessor should be.
  //
  // `configurable: true` is required: the target is an empty object, and a
  // proxy may not report a non-configurable property its target does not have.
  ownKeys() {
    return Reflect.ownKeys(held('ownKeys'))
  },
  getOwnPropertyDescriptor(_t, key) {
    if (key === 'db' || key === 'me' || key === 'config') return undefined
    const d = Reflect.getOwnPropertyDescriptor(held(key), key)
    return d ? { ...d, configurable: true } : undefined
  },
})

// ─── Which service is announcing this call? ───────────────────────────────
// Read by the Litestone adapter's write tap, which announces a write that
// nothing else did. Every service write also passes that tap, so without this
// the same mutation would be broadcast twice — once by callService's
// announcement point and once by the tap underneath it.
//
// It holds the service NAME rather than a boolean, because the suppression has
// to be as narrow as the announcement. `callService` announces for the service
// it is running; a write to a DIFFERENT model from inside a hook — the audit
// row an orders hook writes — is not covered by that announcement and must
// still fire. A boolean swallowed it, measured.
//
// An ALS rather than a counter or a field: calls interleave, and a depth
// integer shared between two concurrent requests decrements under the wrong
// one. A nested call re-runs this with its own name, so the innermost scope is
// what the tap compares against — which is exactly the call that will announce.
const _serviceCallStore = new AsyncLocalStorage<string>()

export function runInServiceCall<T>(service: string, fn: () => T): T {
  return _serviceCallStore.run(service, fn)
}

/** The service whose announcement covers a write happening right now, if any. */
export function announcingService(): string | undefined {
  return _serviceCallStore.getStore()
}

/**
 * The principal for an internal call — the one owner of *auth propagates*.
 *
 * Both places that build an internal `ServiceContext` ask this rather than
 * carrying the rule, because the rule is three lines and the two copies would
 * be the same call answering two things depending on which door it came in by.
 *
 *   opts has no `auth` key   → inherit the request's principal (propagation)
 *   opts.auth.user is null   → as nobody, deliberately
 *   opts.auth.user is a user → that one, frozen
 *
 * `in`, not `??`: absent and null are different answers, and conflating them
 * removes the only way to say *read this as a stranger would*.
 */
export function inheritedClient(): { ip?: string; userAgent?: string; headers: Record<string, string> } {
  // `{}` with an empty header bag when there is nothing to inherit — a job or a
  // script has no client, and the shape stays the same either way so a reader
  // never has to test for it.
  return _requestStore.getStore()?.client ?? { headers: {} }
}

export function resolvePrincipal(opts: CallOptions): SessionContext | null {
  if ('auth' in opts && opts.auth !== undefined)
    return opts.auth?.user ? freezeUser(opts.auth.user) : null

  const inherited = _requestStore.getStore()?.user
  return inherited ? freezeUser(inherited) : null
}

// ─── Auth principal sharing ──────────────────────────────────────────────
// The session user is treated as read-only once it enters the service
// layer. Instead of deep-cloning it on EVERY internal call (hot-path
// allocation, and fan-out patterns clone repeatedly), we freeze it once
// and share the reference: mutation attempts throw in strict mode instead
// of silently leaking into sibling calls, and already-frozen objects pass
// through for free. Session objects are created fresh per verifySession(),
// so freezing never bleeds across requests.

export function freezeUser<T extends object>(user: T): T {
  if (Object.isFrozen(user)) return user
  // Shallow-freeze nested plain objects too — SessionContext is flat in
  // practice, but a permissions array/object shouldn't be a mutation hole.
  for (const v of Object.values(user)) {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) Object.freeze(v)
  }
  return Object.freeze(user)
}

// ─── The caller's IP, whichever context you are holding ───────────────────────
//
// A TransportContext carries `ip` at the top level, because at that point there
// is nothing else — no service, no principal. A ServiceContext splits the client
// facts into `ctx.client`, so the same value lives at `ctx.client.ip`.
//
// One accessor for both, because that one-line gap is what grew a third rate
// limiter inside @frontierjs/auth (FJS-017). Anything that runs on both sides of
// the bridge should ask this rather than pick a side.
export function clientIp(ctx: unknown): string {
  const c = ctx as { client?: { ip?: string }; ip?: string } | null | undefined
  return c?.client?.ip ?? c?.ip ?? 'unknown'
}
