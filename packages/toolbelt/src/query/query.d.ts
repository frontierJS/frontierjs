/*
 * query.d.ts — the kit's types, hand-written.
 *
 * This package is plain JS with no build step, and every other kit is imported
 * from a package whose tsconfig sets `allowJs` (which is what `@frontierjs/config`
 * gives an app). This one is reached from `@frontierjs/junction/client`, whose
 * public type surface an app may compile under its OWN options — so a kit with
 * no declaration is a TS7016 in somebody else's build.
 */

/** A structured query: filter keys to scalars, arrays, or operator objects. */
export type Query = Record<string, unknown>

export const LIMITS: Readonly<{ depth: number; keys: number; items: number }>

/** Does this text survive `String(Number(v)) === v`? The whole number rule. */
export function isNumericLiteral(v: unknown): boolean

/** One text value → what the caller meant. A non-string passes through. */
export function parseValue(v: unknown): unknown

/** Raw `key → text` pairs → the structured, typed query. */
export function parseParams(
  params: Record<string, unknown> | Iterable<[string, unknown]> | null | undefined,
): Query

/** A URL's search string, with or without the `?` → the structured, typed query. */
export function parseQueryString(search: string | null | undefined): Query

/** The structured query → flat `key → text` pairs. The inverse of parseParams. */
export function encodePairs(query: Query | null | undefined): Array<[string, string]>

/** The structured query → a search string, `?` included, or `''`. */
export function encodeQueryString(query: Query | null | undefined): string
