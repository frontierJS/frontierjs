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
import type { QueryDirectives } from './directives.ts'
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
  paginate?: { limit: number; offset: number; [k: string]: unknown }
  [key: string]: unknown
}

// ─── Query directives ─────────────────────────────────────────────────────
// Declared in core/directives.ts — a module that imports nothing, so the
// browser client can name the same fields without dragging
// node:async_hooks into a bundle. Re-exported here because this is where the
// API realm has always found it.

export type { QueryDirectives } from './directives.ts'

// ─── Hook type ────────────────────────────────────────────────────────────
// `method` is the phase where the service method itself runs. It is not a hook
// slot anyone registers into, but `runPipeline` DOES set `ctx.type = 'method'`
// while the method executes, so a hook or an `around` reading `ctx.type` can
// legitimately see it. Leaving it out of the union made the assignment a type
// error inside the pipeline and a lie to everyone reading it.
export type HookType = 'before' | 'method' | 'after' | 'around' | 'error'

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
}

const _requestStore = new AsyncLocalStorage<RequestMeta>()

// Framework-internal: the bridge wraps the entire pipeline run in this
// so every hook/method/internal-call is "inside the truck."
export function runWithMeta<T>(meta: RequestMeta, fn: () => T): T {
  return _requestStore.run(meta, fn)
}

// The accessor authors use. Returns undefined outside a request
// (e.g. during boot / service init).
export function requestMeta(): RequestMeta | undefined {
  return _requestStore.getStore()
}

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
