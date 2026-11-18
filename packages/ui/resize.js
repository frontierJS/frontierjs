/*
 * resize.js — the edge a person drags to size a pane, as a Mesa attachment.
 *
 *   <div aria-label="Resize the list"
 *        {@attach resizeHandle(() => ({ size: width, set: (w) => width = w, min: 160, max: 480 }))}>
 *
 *   size      the pane's current size in px; read at the press and at each key
 *   set(px)   write the new size, already clamped and rounded
 *   min, max  the bounds, read at each event, so a max that follows the window stays right
 *   grows     1 (default) when moving right or down widens the pane, as a handle on its
 *             end edge does; -1 for a handle on its start edge, as a right-docked panel has
 *   axis      'x' (default) sizes a width, 'y' a height
 *   step      px per arrow press (default 16); Shift moves four steps
 *   reset()   what a double-click does; absent, a double-click does nothing
 *   start()   a drag has begun — where an app sets the cursor across its frame
 *   end(px)   a drag is over or a key has moved the size — where an app saves. A cancelled
 *             drag ends too, with the size it had at the press, so a flag set in `start`
 *             always clears. A reset calls nothing: forgetting a saved size is its own line
 *
 * The handle gets `role="separator"`, a tab stop and `aria-orientation` when it
 * has none, and `aria-valuenow/min/max` at each change it makes and again on
 * focus, so a screen reader reads the size the pane has now. The label is the
 * caller's: only it knows which pane this is.
 *
 * It stores nothing (FJS-D2259): `end` is where an app remembers the size.
 */
import { drag } from './drag.js'

/**
 * @param {() => {
 *   size: number,
 *   set: (px: number) => void,
 *   min: number,
 *   max: number,
 *   grows?: 1 | -1,
 *   axis?: 'x' | 'y',
 *   step?: number,
 *   reset?: () => void,
 *   start?: () => void,
 *   end?: (px: number) => void,
 * }} options
 */
export function resizeHandle(options) {
  if (typeof options !== 'function') {
    throw new TypeError('resizeHandle: pass a getter — resizeHandle(() => ({ size, set, min, max })) — so each event reads current state')
  }
  const clamp = (o, px) => Math.round(Math.min(o.max, Math.max(o.min, px)))

  return (el) => {
    function describe(o, now = o.size) {
      el.setAttribute('aria-valuenow', String(Math.round(now)))
      el.setAttribute('aria-valuemin', String(Math.round(o.min)))
      el.setAttribute('aria-valuemax', String(Math.round(o.max)))
    }
    function put(o, px) {
      const w = clamp(o, px)
      o.set(w)
      describe(o, w)
      return w
    }

    const gesture = drag(() => ({
      start: () => {
        const o = options()
        o.start?.()
        return o.size
      },
      move: (_e, from, d) => {
        const o = options()
        put(o, from + (o.grows ?? 1) * (o.axis === 'y' ? d.y : d.x))
      },
      end: (_e, from, { cancelled }) => {
        const o = options()
        const w = cancelled ? put(o, from) : clamp(o, o.size)
        o.end?.(w)
      },
    }))

    function keydown(e) {
      const o = options()
      const step = (o.step ?? 16) * (e.shiftKey ? 4 : 1)
      const [less, more] = o.axis === 'y' ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight']
      let px
      if (e.key === more) px = o.size + (o.grows ?? 1) * step
      else if (e.key === less) px = o.size - (o.grows ?? 1) * step
      else if (e.key === 'Home') px = o.min
      else if (e.key === 'End') px = o.max
      else return
      e.preventDefault()
      // Not `o.end?.(put(...))`: an absent `end` skips evaluating its argument, and the key does nothing.
      const w = put(o, px)
      o.end?.(w)
    }
    function dblclick() {
      const o = options()
      if (!o.reset) return
      o.reset()
      // A reset to the stylesheet's size is measured only after the redraw.
      requestAnimationFrame(() => describe(options()))
    }
    const focus = () => describe(options())

    if (!el.hasAttribute('role')) el.setAttribute('role', 'separator')
    if (!el.hasAttribute('tabindex')) el.tabIndex = 0
    if (!el.hasAttribute('aria-orientation')) {
      el.setAttribute('aria-orientation', options().axis === 'y' ? 'horizontal' : 'vertical')
    }
    describe(options())

    const undrag = gesture(el)
    el.addEventListener('keydown', keydown)
    el.addEventListener('dblclick', dblclick)
    el.addEventListener('focus', focus)
    return () => {
      undrag()
      el.removeEventListener('keydown', keydown)
      el.removeEventListener('dblclick', dblclick)
      el.removeEventListener('focus', focus)
    }
  }
}
