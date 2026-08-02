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
import type { ServiceResult as _ServiceResult } from './envelope.ts'

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

  // ── app reference ─────────────────────────────────────────────────────
  app: import('./app.ts').App

  // ── lifecycle ─────────────────────────────────────────────────────────
  // result is null in before hooks. Populated envelope in after hooks.
  result:  _ServiceResult | null
  error:   FrameworkError | null

  // ── HTTP-specific ─────────────────────────────────────────────────────
  statusCode?: number          // override HTTP status
  dispatch?:   unknown | false // separate payload for real-time broadcast; false = suppress

  // escape hatch — never use in services or hooks (type-only upward ref)
  $raw: import('../transport/types.ts').TransportContext | null

  // instrumentation — set by callService, undefined for bypass (_find etc.)
  telemetryId?: string

  // cleanup callbacks — called in callService finally block after pipeline
  // completes. Used by litestone $tapQuery teardown and any other
  // per-request teardown. NOT scratch — framework-internal.
  _cleanups?: Array<() => void>
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
// The internal form of what arrives on the wire as $limit, $offset, $orderBy,
// $select, $populate, $search, $withDeleted, $onlyDeleted.
//
// `$` is TRANSPORT SYNTAX. It is a way of saying "this key is a directive, not
// a column" inside a flat query string, and it has no business existing past
// the bridge. Keeping it internal meant the transport and the query builder
// both had opinions about the same keys — and they disagreed: the bridge
// stripped $limit/$offset/$orderBy/$select from ctx.query as "reserved", and
// parseQuery then looked for exactly those four keys on ctx.query and found
// nothing. Pagination, ordering and field selection were all inert over HTTP.

export interface QueryDirectives {
  limit?:       number
  offset?:      number
  /** Raw sort spec — 'name,-createdAt' | { name: 'asc' } | [{...}] */
  orderBy?:     unknown
  /** Raw select spec — 'id,name' | ['id','name'] */
  select?:      unknown
  /** Relations to include — 'author' | 'author:id+name' */
  populate?:    unknown
  /** Full-text search term (FTS5). */
  search?:      string
  withDeleted?: boolean
  onlyDeleted?: boolean
}

// ─── Hook type ────────────────────────────────────────────────────────────
export type HookType = 'before' | 'after' | 'around' | 'error'

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
// Stripped from ctx.query before reaching Litestone / service methods.
// $first and $wrap are transport-only — never reach service layer.
// Every `$` key the wire understands. Removed from ctx.query so a directive
// can never be mistaken for a column filter.
//
// $populate/$search/$withDeleted/$onlyDeleted were missing here while
// parseQuery destructured them off ctx.query — they worked by accident, on the
// same conflation that made $limit fail. With directives split out they must
// be listed, or they would leak into the WHERE clause as unknown columns.
export const RESERVED_PARAMS = new Set([
  '$limit', '$offset', '$orderBy', '$select',
  '$populate', '$search', '$withDeleted', '$onlyDeleted',
  '$first', '$wrap',
])

// ─── Request-wide metadata (AsyncLocalStorage) ────────────────────────────
// Correlation id, idempotency key, locale belong to the WHOLE request,
// not any single call. They ride an ALS store the bridge wraps the
// pipeline run in. Read anywhere, any depth, via requestMeta().

export interface RequestMeta {
  correlationId:   string
  idempotencyKey?: string
  locale?:         string
  origin:          'http' | 'websocket' | 'internal'
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
