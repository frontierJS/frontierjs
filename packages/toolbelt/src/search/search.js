/*
 * search.js — fuzzy matching: does this text match a query, how well, and WHERE.
 *
 * The kit exists because three places in this repo answer that question and
 * each answered it differently. `@frontierjs/ui`'s MultiSelect scored with
 * `indexOf` plus a prefix bonus; its CommandPalette used `String.includes` and
 * did not rank at all; a fourth caller is coming the moment a filter bar or a
 * schema-driven table needs to narrow a list. Same shape as `/inflect` and
 * `/directives`: one definition, several callers, and the copies disagreed.
 *
 * ─── Ranges, never markup ───────────────────────────────────────────────────
 *
 * Every function here answers WHERE a match landed as index pairs. None of them
 * returns HTML, and that is deliberate rather than minimal.
 *
 * The implementation this replaces built a string — `<mark>` around each match,
 * rendered with `{@html}` — and nothing escaped the text around it. That is
 * survivable while labels are written by developers and unsurvivable now that
 * `resource.options()` fills a picker from database rows: a customer named
 * `<img src=x onerror=…>` executes in every screen that offers them. A kit that
 * returns markup cannot be used safely by a caller who forgets, so this one
 * cannot return markup. `segments()` is the rendering primitive instead — a
 * list a template walks with real elements, which cannot inject by construction.
 *
 * ─── Ranges beside the item, never on it ───────────────────────────────────
 *
 * `rank()` answers `{ item, score, ranges }` and never writes to `item`. The
 * implementation this replaces did the opposite (`r.item._highlight = r.matches`),
 * which means one object in two lists carries the last search's ranges, and a
 * cleared query leaves them behind — the old component only looked right
 * because its template re-checked the query before reading them.
 */

import { QuickScore } from './QuickScore.js'
import { quickScore } from './quick-score.js'

/**
 * @typedef {[number, number]} MatchRange  Start and end index, end exclusive.
 */

/**
 * Score one string against a query.
 *
 * @param   {string} text
 * @param   {string} query
 * @returns {{ score: number, ranges: MatchRange[] }} `score` is 0–1, higher is
 *   better; 0 means no match. `ranges` is empty when nothing matched and when
 *   the query is empty.
 */
export function score(text, query) {
  const t = text == null ? '' : String(text)
  const q = query == null ? '' : String(query)

  // The algorithm's own defaults lowercase both arguments, so a null reaching
  // it is a TypeError from inside a library rather than an answer here.
  if (!t) return { score: 0, ranges: [] }

  const ranges = []
  return { score: quickScore(t, q, ranges), ranges }
}

/**
 * Rank items against a query, best first.
 *
 * @param {unknown[]} items   Strings, or objects with `keys` naming what to score.
 * @param {string}    query   Empty answers every item, unranked — a picker
 *   opening with nothing typed shows its whole list.
 * @param {object}   [opts]
 * @param {Array<string|string[]>} [opts.keys]  Which fields to score. A nested
 *   path is an array: `['customer', 'name']`.
 * @param {number}   [opts.minimumScore=0]  Below this an item is dropped.
 * @param {number}   [opts.limit]  Keep at most this many.
 * @returns {Array<{ item: unknown, score: number, key: string|null, ranges: MatchRange[], byKey?: Record<string, MatchRange[]> }>}
 *   `key` is the field that scored best (`null` for plain strings) and `ranges`
 *   are its ranges — so a caller highlighting one label needs no lookup.
 *   `byKey` is present only when `keys` was passed, for a row that renders
 *   several fields and wants each marked.
 */
export function rank(items, query, { keys, minimumScore = 0, limit } = {}) {
  if (!Array.isArray(items) || items.length === 0) return []

  const q  = query == null ? '' : String(query)
  const qs = new QuickScore(items, { ...(keys ? { keys } : {}), minimumScore })

  const out = qs.search(q).map((r) => {
    // A string list answers a flat array of ranges; a keyed list answers a map,
    // and `scoreKey` names the field that won. Normalizing to one array here is
    // what keeps the common case — highlight the label — a single read.
    const keyed  = r.matches && !Array.isArray(r.matches)
    const key    = keyed ? (r.scoreKey || null) : null
    const ranges = keyed ? (r.matches[key] ?? []) : (r.matches ?? [])

    return keyed
      ? { item: r.item, score: r.score, key, ranges, byKey: r.matches }
      : { item: r.item, score: r.score, key, ranges }
  })

  return typeof limit === 'number' ? out.slice(0, limit) : out
}

/**
 * Merge overlapping or touching ranges into a minimal ascending set.
 *
 * Needed whenever ranges from two searches describe one string — a query
 * matched across fields, or a highlight is layered over a previous one.
 *
 * @param   {MatchRange[]} [existing]
 * @param   {MatchRange[]} [added]
 * @returns {MatchRange[]}
 */
export function mergeRanges(existing = [], added = []) {
  const all = [...existing, ...added].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const out = []

  for (const [start, end] of all) {
    const last = out[out.length - 1]
    // `start <= last[1]` rather than `<`, so [0,3] and [3,5] become [0,5] —
    // two adjacent ranges are one run of matched characters, and rendering
    // them apart puts a seam in the middle of a highlight.
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else out.push([start, end])
  }

  return out
}

/**
 * Split text into alternating matched and unmatched pieces.
 *
 * The safe replacement for a `highlight()` that returned HTML: a template walks
 * this and emits its own elements, so no caller can inject and none has to
 * remember to escape.
 *
 *   {#each segments(label, ranges) as part}
 *     {#if part.match}<mark>{part.text}</mark>{:else}{part.text}{/if}
 *   {/each}
 *
 * @param   {string} text
 * @param   {MatchRange[]} [ranges]  Merged internally, so overlapping input is fine.
 * @returns {Array<{ text: string, match: boolean }>}  Never empty for non-empty
 *   text; empty pieces are omitted, so a match at index 0 does not lead with ''.
 */
export function segments(text, ranges = []) {
  const t = text == null ? '' : String(text)
  if (!t) return []
  if (!ranges.length) return [{ text: t, match: false }]

  const out = []
  let last  = 0

  for (const [start, end] of mergeRanges(ranges)) {
    // Clamp: ranges may have been computed against a different transformation
    // of this string, and a slice past the end is silently '' rather than an
    // error, which would hide the mismatch.
    const s = Math.max(0, Math.min(start, t.length))
    const e = Math.max(s, Math.min(end, t.length))

    if (s > last) out.push({ text: t.slice(last, s), match: false })
    if (e > s)    out.push({ text: t.slice(s, e),    match: true })
    last = e
  }

  if (last < t.length) out.push({ text: t.slice(last), match: false })

  return out
}
