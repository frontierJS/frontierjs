// ─── query-values.ts — what a directive's VALUE means, once ──────────────────
//
// `@frontierjs/toolbelt/directives` says which `$` names exist and reads them
// off a wire; it deliberately does not fix the SHAPE of the two that have
// several legal spellings, because only a query builder can say which. This is
// that answer, and it is here rather than inside one caller because it is asked
// from opposite ends of the wire — and from a third end since the device grew a
// database of its own:
//
//   normalizeOrderBy  — the three spellings a caller may write → one list.
//                       `parseSort` (core/litestone.ts) is this function; the
//                       server compiles the result into SQL.
//   normalizeSelect   — a comma-joined string or a list of names → the map a
//                       query builder takes. `parseSelect` is this function.
//   comparatorFor     — that same orderBy list → a comparator over records, for
//                       the browser client, which has to place a pushed row in
//                       a list it cannot re-query.
//
// **A caller that spells one of these itself is a second answer to a settled
// question, and it fails where nothing is watching**: Sierra's offline read
// handed SQLite the wire's own `-id` and every read of a sorted list threw,
// which the list cache underneath then answered — a feature that was off and
// green (`FJS-1179`).
//
// This module imports nothing. That is deliberate: the browser client bundles
// it, and `core/litestone.ts` — the other caller — reaches the Data realm.
//
// **The comparator is an approximation of SQLite's ORDER BY, and where it
// cannot be exact it is stated rather than assumed.** It agrees on the things
// that decide a list's order in practice: NULLs first ascending (SQLite's
// default, which negating gives NULLs last descending), numbers before text,
// booleans as the 0/1 they are stored as, and ISO-8601 DateTime text comparing
// as text — which is the same comparison SQLite makes on the same column. It
// does NOT reproduce a non-BINARY collation, and JavaScript orders strings by
// UTF-16 code unit where SQLite orders by byte; the two agree on ASCII and can
// differ past it. A list whose order matters that much re-reads.

export type SortParam =
  | string
  | Record<string, number | string>
  | Record<string, string>[]

export type OrderBy = Record<string, unknown>[]

/**
 * The three spellings → `[{ field: 'asc' | 'desc' }]`.
 *
 *   'name'                    ascending
 *   '-createdAt'              descending
 *   'status,-createdAt'       several, in order
 *   { createdAt: 'desc' }     object form; 1 / -1 also accepted
 *   [{ a: 'asc' }, { b: … }]  already normalized
 *
 * **A STRUCTURED value is not one of the three and travels untouched.** The
 * Data boundary takes several orderings whose value is an object rather than a
 * direction — a relation hop (`{ author: { name: 'asc' } }`), a nulls placement
 * (`{ deletedAt: { dir: 'asc', nulls: 'last' } }`) and a distance
 * (`{ site: { near: { lat, lng } } }`) — and the ternary below read every one
 * of them as *not ascending*: all three arrived as `{ field: 'desc' }`, which
 * is a relation hop flattened onto the relation, a nulls placement with its
 * direction INVERTED and its placement gone, and a distance order refused by
 * name as a sort of the JSON document.
 *
 * The transport carries all three intact (`FJS-962` is the ruling that made it
 * so) and this flattened them one layer later, which is why nothing on either
 * side of the wire could see it.
 */
export function normalizeOrderBy(sort: SortParam): OrderBy {
  if (typeof sort === 'string') {
    return sort.split(',').map((field) => {
      const f = field.trim()
      if (f.startsWith('-')) return { [f.slice(1)]: 'desc' as const }
      return { [f]: 'asc' as const }
    })
  }
  if (Array.isArray(sort)) return sort as OrderBy
  return Object.entries(sort).map(([field, dir]) => ({
    [field]: isDirection(dir)
      ? ((dir === 1 || dir === 'asc') ? 'asc' as const : 'desc' as const)
      : dir,
  }))
}

/** A direction is a word or a sign. Anything structured is an ARGUMENT. */
function isDirection(v: unknown): boolean {
  return v === null || (typeof v !== 'object' && typeof v !== 'function')
}

export type SelectParam = string | string[]

/**
 * `'id,name'` or `['id', 'name']` → `{ id: true, name: true }`.
 *
 * The map is what every query builder here takes, and the string is what a URL
 * carries, so the two spellings meet exactly once.
 */
export function normalizeSelect(select: SelectParam): Record<string, boolean> {
  const fields = Array.isArray(select) ? select : String(select).split(',')
  const out: Record<string, boolean> = {}
  for (const f of fields) {
    const name = f.trim()
    if (name) out[name] = true
  }
  return out
}

// SQLite's storage-class order: NULL < INTEGER/REAL < TEXT < BLOB. A Boolean is
// stored as 0/1 and therefore sorts as a number; a DateTime is ISO-8601 TEXT.
function rank(v: unknown): number {
  if (v === null || v === undefined) return 0
  if (typeof v === 'number' || typeof v === 'boolean') return 1
  if (typeof v === 'string') return 2
  return 3
}

/** One value against another, as the column holding them would be ordered. */
export function compareValues(a: unknown, b: unknown): number {
  const ra = rank(a), rb = rank(b)
  if (ra !== rb) return ra - rb
  if (ra === 0) return 0

  if (ra === 1) {
    const na = typeof a === 'boolean' ? (a ? 1 : 0) : a as number
    const nb = typeof b === 'boolean' ? (b ? 1 : 0) : b as number
    return na < nb ? -1 : na > nb ? 1 : 0
  }

  if (ra === 2) return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0

  // A Json, an array or a File column cannot be ordered by at all — the server
  // refuses it by name (`opaque`), so a load naming one never returned rows for
  // this to place. Answering "equal" keeps the comparator total without
  // inventing an order for values that have none.
  return 0
}

/**
 * A comparator over records for an `orderBy`, or `null` when there is nothing
 * to order by — which the caller must treat as *leave the list alone*, not as
 * *sort by nothing*.
 */
export function comparatorFor(
  sort: SortParam | undefined | null
): ((a: Record<string, unknown>, b: Record<string, unknown>) => number) | null {
  if (sort == null) return null
  // A structured value is an ordering this side cannot reproduce: a relation
  // hop reads a column that is not on the record, a nulls placement is about
  // rows this comparator never sees, and a distance needs a center and the geo
  // kit. Skipped rather than read as a direction — placing a pushed row by the
  // TEXT of a JSON document is a wrong position asserted confidently, where
  // dropping the key leaves the rest of the ordering doing its job and the
  // caller's `resource.stale` saying the list should be re-read.
  const keys = normalizeOrderBy(sort)
    .map((entry) => {
      const field = Object.keys(entry)[0]
      if (!field) return null
      const dir = entry[field]
      if (dir !== null && typeof dir === 'object') return null
      return { field, desc: dir === 'desc' }
    })
    .filter((k): k is { field: string; desc: boolean } => k !== null)

  if (!keys.length) return null

  return (a, b) => {
    for (const { field, desc } of keys) {
      const c = compareValues(a?.[field], b?.[field])
      if (c !== 0) return desc ? -c : c
    }
    return 0
  }
}
