/*
 * directives.d.ts — the kit's types, hand-written.
 *
 * `query.d.ts`'s reason exactly: this package is plain JS with no build step,
 * and this kit is reached from `@frontierjs/junction/client`, whose public type
 * surface an app compiles under its OWN options — so a kit with no declaration
 * is a TS7016 in somebody else's build. Junction's `client-types.test.ts` is
 * what says so, and it said so the moment the client reached for this table
 * rather than keeping a copy.
 */

/** The structured form of the `$` keys. Absent means *not asked*. */
export interface Directives {
  limit?:         number
  offset?:        number
  after?:         string
  orderBy?:       unknown
  select?:        unknown
  populate?:      unknown
  search?:        string
  withDeleted?:   boolean
  onlyDeleted?:   boolean
  withTemplates?: boolean
  onlyTemplates?: boolean
}

/** Every `$` name that has a structured form. */
export const DIRECTIVE_PARAMS: readonly string[]

/** Transport-only `$` names: they shape the answer, not the question. */
export const TRANSPORT_PARAMS: readonly string[]

/** Every `$` key the wire understands. Neither kind is a filter. */
export const RESERVED_PARAMS: ReadonlySet<string>

/** The `$` keys this table does not know, in the order they arrived. */
export function unknownDirectives(params: Record<string, unknown> | null | undefined): string[]

/** The `$` keys of a parameter bag → the structured directives. */
export function parseDirectives(params: Record<string, unknown> | null | undefined): Directives

/** The structured directives → the `$` keys that carry them. */
export function directiveParams(directives: Directives | null | undefined): Record<string, unknown>

/** The column a sorted header marks, and which way. An empty key is *nothing is sorted*. */
export interface OrderByPair {
  key: string
  dir: 'asc' | 'desc'
}

/** An `orderBy` directive → the pair a sorted header marks. Reads every legal shape. */
export function orderByPair(orderBy: unknown): OrderByPair

/** The pair → the `orderBy` a page writes back. `orderByPair`'s inverse; an empty key answers `undefined`. */
export function orderByValue(key: string, dir?: 'asc' | 'desc'): string | undefined

/** One bag of parameters → the two things it was carrying. Neither half has a `$`. */
export function splitParams(params: Record<string, unknown> | null | undefined): {
  query: Record<string, unknown>
  directives: Directives
}
