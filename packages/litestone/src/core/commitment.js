/*
 * commitment.js — `@@commitment`: when a declared transition is OWED.
 *
 * A commitment is a transition the system owes a row at a time (`FJS-D353`).
 * This module answers the Data realm's half — *which rows are due by T, and
 * when is each one due* — and nothing else. It schedules nothing and makes no
 * transition: Caravan owns the clock (`FJS-D36`) and the fire is the API
 * realm's, which re-asks this module before it moves a row.
 *
 * The due time is computed TWICE and that is the trap in this file. The filter
 * is SQL, because it has to run over a table; the `dueAt` handed back is
 * JavaScript, because it has to leave as a value — and that half is
 * `@frontierjs/toolbelt/datetime`'s `dueAt`, because a browser computes the same
 * thing off `x-commitments` with no database at all. The two agree only
 * because `test/commitment.test.ts` grades them against each other over month
 * ends, leap days and negative offsets — a month added in SQLite overflows
 * (`date('2026-01-31', '+1 months')` is March 3rd) where `addToDate` clamps to
 * February 28th, so the SQL spells the clamp out rather than using the modifier
 * bare.
 */

import { plainDateIn }            from '@frontierjs/toolbelt/datetime'
import { unitInfo }               from '@frontierjs/toolbelt/units'
import { fieldToColumnName }      from './ddl.js'

// ─── the map ──────────────────────────────────────────────────────────────────
// { modelName: [{ name, transition, via, target, field, from, on, kind, offset,
// while }] | null }. `name` is the declared spelling (`abandon`,
// `subscription.lapse`) and what `due({ transition })` selects by; `transition`,
// `field` and `from` are the TARGET's move, which is this model's own unless
// `via` names the to-one relation it is reached through (`FJS-D362`).
// Pre-computed for `buildEffectiveMap`'s reason, and because the parser has
// already refused every shape below that does not resolve, nothing here
// re-checks it.

export function buildCommitmentMap(schema) {
  const map = {}
  const movesOf = (m) => {
    const moves = new Map()
    for (const t of m.attributes.filter(a => a.kind === 'transitions'))
      for (const [name, spec] of Object.entries(t.transitions)) moves.set(name, { field: t.field, from: spec.from })
    return moves
  }
  for (const model of schema.models) {
    const decls = model.attributes.filter(a => a.kind === 'commitment')
    if (!decls.length) { map[model.name] = null; continue }
    const col = (name) => fieldToColumnName(model.fields.find(f => f.name === name))
    map[model.name] = decls.map(d => {
      const via    = d.via ?? null
      const target = via ? schema.models.find(m => m.name === model.fields.find(f => f.name === via).type.name) : model
      const onField = model.fields.find(f => f.name === d.on.field)
      const kind    = onField?.attributes?.some(a => a.kind === 'date') ? 'day' : 'instant'
      const off     = d.on.offset
      const offset  = !off ? null
        : off.field
          ? { sign: off.sign, field: off.field, column: col(off.field),
              unit: model.fields.find(f => f.name === off.field)?.attributes.find(a => a.kind === 'unit')?.symbol }
          : { sign: off.sign, value: off.value, unit: off.unit }
      const move = movesOf(target).get(d.transition)
      return {
        name:       d.name ?? d.transition,
        transition: d.transition,
        via,
        target:     target.name,
        field:      move.field,
        from:       move.from,
        on:         d.on.field,
        onColumn:   col(d.on.field),
        kind, offset,
        while:      d.while ?? null,
      }
    })
  }
  return map
}

// ─── the due time, in SQL ─────────────────────────────────────────────────────
// An expression over the row answering its due time in the column's own text
// form — ISO-8601 with milliseconds and a `Z` for an instant, `YYYY-MM-DD` for a
// day — so it compares as a string against `by` the way every stored time here
// does. NULL wherever the anchor or the offset is NULL, which is *not owed yet*.
//
// Amounts are BOUND, never spliced. The column names are the schema's own.

const INSTANT = `'%Y-%m-%dT%H:%M:%fZ'`

export function dueSql(c) {
  const on  = `"${c.onColumn}"`
  const off = c.offset
  if (c.kind === 'instant') {
    if (!off) return { sql: `strftime(${INSTANT}, ${on})`, params: [] }
    const seconds = off.sign * unitInfo(off.unit).factor
    return off.field
      ? { sql: `strftime(${INSTANT}, ${on}, (? * "${off.column}") || ' seconds')`, params: [seconds] }
      : { sql: `strftime(${INSTANT}, ${on}, ?)`, params: [`${seconds * off.value} seconds`] }
  }
  if (!off) return { sql: `date(${on})`, params: [] }
  const amount = (per) => off.field
    ? { sql: `(? * "${off.column}")`, params: [off.sign * per] }
    : { sql: `?`,                      params: [off.sign * per * off.value] }
  if (off.unit === 'd' || off.unit === 'wk') {
    const n = amount(off.unit === 'wk' ? 7 : 1)
    return { sql: `date(${on}, ${n.sql} || ' days')`, params: n.params }
  }
  // A month, clamped: the same day of the target month, or that month's last
  // day where it is shorter. `start of month` first so the day is added back
  // inside the right month rather than overflowing out of the wrong one.
  const m = amount(off.unit === 'yr' ? 12 : 1)
  return {
    sql: `min(date(${on}, 'start of month', ${m.sql} || ' months', ` +
         `(CAST(strftime('%d', ${on}) AS INTEGER) - 1) || ' days'), ` +
         `date(${on}, 'start of month', (${m.sql} + 1) || ' months', '-1 days'))`,
    params: [...m.params, ...m.params],
  }
}

// ─── `by`, read in the declaration's kind ─────────────────────────────────────
// An instant is compared as ISO text. A day kind is owed on a DAY, and *which
// day is it* is an instant read in a zone (`FJS-D143`), so `timeZone` is asked
// for there and defaults to UTC — the reading `@@expires` over days already
// takes, stated rather than hidden.

export function readBy(kind, by, timeZone) {
  const at = by instanceof Date ? by : new Date(by)
  if (Number.isNaN(at.getTime())) return null
  if (kind === 'instant') return at.toISOString()
  return plainDateIn(at, timeZone ?? 'UTC')
}
