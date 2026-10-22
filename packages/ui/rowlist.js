/*
 * rowlist.js — the keyboard contract of a list of rows, as a Mesa attachment
 * (FJS-2009).
 *
 *   <ul {@attach rowlist(() => ({
 *     onopen:   (row, e) => goto(row.dataset.id),
 *     onselect: (row, e) => picked.toggle(byId[row.dataset.id]),
 *   }))}>
 *     {#each items as it (it.id)}<li data-row data-id={it.id}>{it.title}</li>{/each}
 *   </ul>
 *
 *   row        a selector for what counts as a row, default `[data-row]`
 *   onopen     Enter on a row
 *   onselect   Space or `x` on a row; leave it out and neither key is taken
 *
 * ↑/↓ or k/j move to the previous/next row, Home/End to the ends. The list is
 * ONE tab stop: the row the cursor is on carries `tabindex="0"` and every other
 * `-1`, and so does every control INSIDE a row that is not the cursor's, or Tab
 * would walk the buttons of fifty rows. Tab crosses the list in one press and
 * comes back to the same row; the controls of the cursor row follow it in Tab
 * order, and a control's own `tabindex` is restored when its row gets the
 * cursor. The cursor follows focus, so clicking a row or tabbing in moves it.
 *
 * Rows come and go under keyed `{#each}`, so the stop is re-asserted after any
 * change to the list, without taking focus. A cursor row that left is replaced
 * by the row now at its place. A row that is `[hidden]` or
 * `[aria-disabled="true"]` is stepped over.
 *
 * The keys are toolbelt's `/keys` tables (`IDEAS/keys.md` 3.3). Only the
 * ROW's own key presses are the list's. A letter typed into a field inside a
 * row is a letter, by the engine's text rule, and Enter or Space on a button
 * inside a row is that button's click, since the open and select tables are
 * active on the row itself alone — so `j` in a row's text box does not move
 * the cursor. No table binds a modified key, so ⌘K, Ctrl+J, Shift+↓ and
 * Shift+Enter are never taken. The roles are the host's to state:
 * a list that opens on Enter is `list`/`listitem`, not `listbox`, so none is
 * written here. The cursor does not wrap, since the ends of an inbox are
 * ends.
 *
 * The argument is a GETTER, as `dndzone`'s and `drag`'s are: it is read at each
 * event, so a callback sees the component's current state and the attachment is
 * not rebuilt when that state changes.
 */

import { keymap, step, chordOf } from '@frontierjs/toolbelt/keys'

const SKIP = '[hidden],[aria-disabled="true"]'
const FOCUSABLE = 'a[href],button,input,select,textarea,summary,[tabindex]'
const FIELD ='input,textarea,select,[contenteditable=""],[contenteditable="true"]'

const MOVES  = keymap({ j: 'next', '<Down>': 'next', k: 'prev', '<Up>': 'prev', '<Home>': 'first', '<End>': 'last' })
const OPEN   = keymap({ '<CR>': 'open' })
const SELECT = keymap({ '<Space>': 'select', x: 'select' })

/**
 * @param {() => {
 *   row?:      string,
 *   onopen?:   (row: HTMLElement, e: KeyboardEvent) => void,
 *   onselect?: (row: HTMLElement, e: KeyboardEvent) => void,
 * }} options
 */
export function rowlist(options) {
  if (typeof options !== 'function') {
    throw new TypeError('rowlist: pass a getter — rowlist(() => ({ onopen })) — so a callback reads current state')
  }
  return (el) => {
    /** @type {HTMLElement | null} */
    let cursor = null
    let index = 0

    const selector = () => options().row ?? '[data-row]'
    const rows = () => [...el.querySelectorAll(selector())].filter((r) => !r.matches(SKIP))
    const rowOf = (node) => node instanceof Element ? node.closest(selector()) : null

    // The tabindex an inner control had before its row stopped being the stop.
    const stated = new WeakMap()

    function place(row) {
      cursor = row
      for (const r of el.querySelectorAll(selector())) {
        r.tabIndex = r === row ? 0 : -1
        for (const c of r.querySelectorAll(FOCUSABLE)) {
          if (r === row) {
            if (!stated.has(c)) continue
            const was = stated.get(c)
            if (was === null) c.removeAttribute('tabindex')
            else c.setAttribute('tabindex', was)
            stated.delete(c)
          } else if (!stated.has(c)) {
            stated.set(c, c.getAttribute('tabindex'))
            c.setAttribute('tabindex', '-1')
          }
        }
      }
    }

    // Keep exactly one stop. Runs on any change to the list, never moves focus.
    function settle() {
      const all = rows()
      if (!all.length) { cursor = null; return }
      if (cursor && all.includes(cursor)) index = all.indexOf(cursor)
      else cursor = all[Math.min(index, all.length - 1)]
      place(cursor)
    }

    function go(row) {
      if (!row) return
      place(row)
      index = rows().indexOf(row)
      row.focus()
      row.scrollIntoView?.({ block: 'nearest' })
    }

    function keydown(e) {
      if (e.defaultPrevented) return
      const row = rowOf(e.target)
      if (!row || !el.contains(row)) return
      const own = e.target === row
      const o = options()
      const active = own ? [MOVES, o.onopen && OPEN, o.onselect && SELECT].filter(Boolean) : [MOVES]
      // Every binding is one key, so no state is held between presses; none
      // is `<Mod-…>`, so either platform's trie answers alike.
      const text = !own && !!e.target.closest?.(FIELD)
      const { action } = step(null, chordOf(e), { active, mac: false, text }, 0).outcome ?? {}
      if (action === undefined) return
      e.preventDefault()
      if (action === 'open') return o.onopen(row, e)
      if (action === 'select') return o.onselect(row, e)
      const all = rows()
      const at = all.indexOf(row)
      go({ next: all[at + 1] ?? row, prev: all[at - 1] ?? row, first: all[0], last: all.at(-1) }[action])
    }

    function focusin(e) {
      const row = rowOf(e.target)
      if (row && el.contains(row) && row !== cursor && !row.matches(SKIP)) {
        place(row)
        index = rows().indexOf(row)
      }
    }

    el.addEventListener('keydown', keydown)
    el.addEventListener('focusin', focusin)
    const watch = new MutationObserver(settle)
    watch.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'aria-disabled'] })
    settle()
    return () => {
      el.removeEventListener('keydown', keydown)
      el.removeEventListener('focusin', focusin)
      watch.disconnect()
    }
  }
}
