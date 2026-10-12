/*
 * selection.js — which rows of a list are ticked, for a screen that acts on
 * several at once (FJS-D671).
 *
 *   const picked = createSelection()                       // keyed by row.id
 *   const picked = createSelection((it) => it.kind + ':' + it.row.id)
 *
 *   picked.has(row)          is this row ticked
 *   picked.toggle(row)       tick it, or untick it
 *   picked.set(rows, on)     tick every one of `rows` (on = true, the default)
 *                            or untick every one (on = false); rows not given
 *                            are left as they are
 *   picked.clear()           untick everything, seen or not
 *   picked.retain(rows)      untick every key not among `rows`
 *   picked.stateOf(rows)     'none' | 'some' | 'all', over `rows` only
 *   picked.count             how many keys are held
 *   picked.keys              those keys, in the order they were ticked
 *
 * It holds KEYS, never rows, so one selection can span two lists or two kinds
 * of row as long as `keyOf` keeps them apart — a message 7 and a ticket 7 are
 * one key under `row.id` and two under `kind + ':' + id`. `keyOf` defaults to
 * `row.id`, and every verb takes a ROW, which is what a template has in hand.
 *
 * A key stays held when its row leaves the screen. A search, a filter, a
 * collapsed group or another page does not untick anything, so `count` and
 * `keys` may name rows nobody can see, and a bulk action acts on `keys` — the
 * number in the bar is what the action will touch. A screen whose rows can
 * go for good (a delete, somebody else's write) calls `retain(allRows)` from a
 * `$:` watch on them, or the bar counts rows that no longer exist.
 *
 * The header box is `stateOf` over the rows it governs, which is what makes a
 * per-group tri-state the same two lines as a whole-list one:
 *
 *   <Checkbox checked={picked.stateOf(rows) === 'all'}
 *             indeterminate={picked.stateOf(rows) === 'some'}
 *             onchange={(on) => picked.set(rows, on)} />
 *
 * A browser ticks a box that was indeterminate, so pressing a part-filled
 * header ticks the rest and pressing a full one unticks those rows only.
 *
 * Signal-backed: every read (`has`, `stateOf`, `count`, `keys`) subscribes
 * whatever template or `$:` is running, and every verb that changes something
 * writes ONE new set, so ticking fifty rows is one update. A verb that
 * changes nothing writes nothing. The verbs are closures, so `rows.filter(picked.has)`
 * works unbound.
 */

import { createSignal } from '@frontierjs/mesa/runtime'

const byId = (row) => row.id

/**
 * @param {(row: any) => unknown} [keyOf] the row's identity; `row.id` when omitted
 */
export function createSelection(keyOf = byId) {
  // A Set keeps insertion order, which is the order things were ticked — the
  // inbox makes the FIRST ticked message the new ticket's title.
  const [read, write] = createSignal(new Set())

  const has = (row) => read().has(keyOf(row))

  function toggle(row) {
    const key = keyOf(row)
    const next = new Set(read())
    if (next.has(key)) next.delete(key)
    else next.add(key)
    write(next)
  }

  function set(rows, on = true) {
    const now = read()
    const next = new Set(now)
    for (const row of rows) {
      if (on) next.add(keyOf(row))
      else next.delete(keyOf(row))
    }
    if (next.size !== now.size) write(next)
  }

  function clear() {
    if (read().size) write(new Set())
  }

  function retain(rows) {
    const now = read()
    if (!now.size) return
    const live = new Set()
    for (const row of rows) live.add(keyOf(row))
    const next = new Set([...now].filter((key) => live.has(key)))
    if (next.size !== now.size) write(next)
  }

  function stateOf(rows) {
    const held = read()
    let ticked = 0
    let total = 0
    for (const row of rows) {
      total++
      if (held.has(keyOf(row))) ticked++
    }
    if (!ticked) return 'none'
    return ticked === total ? 'all' : 'some'
  }

  return {
    has, toggle, set, clear, retain, stateOf,
    get count() { return read().size },
    get keys() { return [...read()] },
  }
}
