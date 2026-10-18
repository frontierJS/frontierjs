// src/core/write-narrowing.ts
//
// Whether an update left every column a read verdict reads as it was. The one
// reader for both consumers of `db.$readColumns` -- a dependent service's
// regrade (`core/litestone.ts`) and a bound room's re-ask (`transport/channels.ts`)
// -- so the two cannot disagree about when a write moved nobody's grade.
// A column absent from either row (a `select`, a protected field stripped from
// both) is unknown, never unchanged, and a missing row says nothing.

const sameValue = (a: unknown, b: unknown): boolean =>
  a instanceof Date && b instanceof Date ? a.getTime() === b.getTime()
  : a && b && typeof a === 'object' && typeof b === 'object' ? JSON.stringify(a) === JSON.stringify(b)
  : Object.is(a, b)

export function columnsUnmoved(columns: Iterable<string>, before: unknown, after: unknown): boolean {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return false
  const was = before as Record<string, unknown>
  const now = after  as Record<string, unknown>
  for (const column of columns)
    if (!(column in was) || !(column in now) || !sameValue(was[column], now[column])) return false
  return true
}
