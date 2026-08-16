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
