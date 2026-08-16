// ─── sort.ts — what `orderBy` means, once ────────────────────────────────────
//
// Two halves of one question, and they are here together because they are asked
// from opposite ends of the wire:
//
//   normalizeOrderBy  — the three spellings a caller may write → one list.
//                       `parseSort` (core/litestone.ts) is this function; the
//                       server compiles the result into SQL.
//   comparatorFor     — that same list → a comparator over records, for the
//                       browser client, which has to place a pushed row in a
//                       list it cannot re-query.
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

export type OrderBy = Record<string, 'asc' | 'desc'>[]

/**
 * The three spellings → `[{ field: 'asc' | 'desc' }]`.
 *
 *   'name'                    ascending
 *   '-createdAt'              descending
 *   'status,-createdAt'       several, in order
 *   { createdAt: 'desc' }     object form; 1 / -1 also accepted
 *   [{ a: 'asc' }, { b: … }]  already normalised
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
    [field]: (dir === 1 || dir === 'asc') ? 'asc' as const : 'desc' as const,
  }))
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
  const keys = normalizeOrderBy(sort)
    .map((entry) => {
      const field = Object.keys(entry)[0]
      return field ? { field, desc: entry[field] === 'desc' } : null
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
