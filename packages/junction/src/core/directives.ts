// core/directives.ts
// QueryDirectives — the structured form of the `$` params, and NOTHING else.
//
// Split out of context.ts for one reason: the browser client needs this type
// and context.ts imports `node:async_hooks`, which does not exist in a browser
// and would be pulled into every bundle by a type-only import that a build
// step failed to erase. This module imports nothing at all, which is the
// property that lets both sides of the wire name the same fields.
//
// context.ts re-exports it, so `from './context.ts'` keeps resolving.

// ─── Query directives ─────────────────────────────────────────────────────
// The internal form of what arrives on the wire as $limit, $offset, $orderBy,
// $select, $populate, $search, $withDeleted, $onlyDeleted, $withTemplates,
// $onlyTemplates — the same names, in the same order, as the table in
// `@frontierjs/toolbelt/directives`, which is what the bridge reads them by.
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
  /**
   * The window's far edge — an opaque cursor the server minted (`FJS-D145`).
   *
   * A caller sending this is growing a window rather than stepping to a page,
   * so it is the keyset path: no OFFSET, no COUNT, and the answer carries the
   * next edge. It never combines with `offset`; a cursor plus an offset names
   * no position either one of them means.
   */
  after?:       string
  /** Raw sort spec — 'name,-createdAt' | { name: 'asc' } | [{...}] */
  orderBy?:     unknown
  /** Raw select spec — 'id,name' | ['id','name'] */
  select?:      unknown
  /** Relations to include — 'author' | 'author:id+name' */
  populate?:    unknown
  /** Full-text search term (FTS5). */
  search?:        string
  withDeleted?:   boolean
  onlyDeleted?:   boolean
  /** @@hasTemplates — the same pair one Data-realm feature over. */
  withTemplates?: boolean
  onlyTemplates?: boolean
}

// ─── The page ─────────────────────────────────────────────────────────────
// What a limit and an offset MEAN, answered once.
//
// Two callers had two answers and only one of them worked. `parseQuery` reads
// `Number()` and falls back on a non-finite result, because a NaN limit reaches
// SQLite as a bind failure rather than as "no limit" — and treats a limit of 0
// as meaningful, since that is how a caller asks for the count alone. The
// `paginate()` hook used `parseInt` + `Math.min`, so `$limit=abc` gave it
// `Math.min(NaN, 100)` — NaN — where the same request through a model service
// gave the default.
//
// It lives here rather than beside either caller because this module imports
// nothing: it is where the directive table already is, and a clamp is a fact
// about a directive.

export interface Page { limit: number; offset: number }

export function clampPage(
  directives:   QueryDirectives | undefined,
  defaultLimit: number,
  maxLimit:     number,
  fallback:     { limit?: unknown; offset?: unknown } = {},
): Page {
  // `??` not `||`: a limit of 0 is a real request, for the count alone.
  const limitRaw  = directives?.limit  ?? fallback.limit  ?? defaultLimit
  const offsetRaw = directives?.offset ?? fallback.offset ?? 0

  const limit  = Number(limitRaw)
  const offset = Number(offsetRaw)

  // Floored as well as ceiled. SQLite reads a negative LIMIT as UNBOUNDED, so
  // `$limit=-1` served the whole table from an endpoint capped at 100 — the
  // ceiling was the only bound anybody had written, and it is the bound the
  // hostile value goes the other way round (`FJS-683`). The bridge refuses a
  // negative directive by name; this is the floor for every caller that does
  // not come through it — an internal call, a `paginate()` fallback, a hook.
  return {
    limit:  Math.max(0, Math.min(Number.isFinite(limit) ? limit : defaultLimit, maxLimit)),
    offset: Math.max(0, Number.isFinite(offset) ? offset : 0),
  }
}
