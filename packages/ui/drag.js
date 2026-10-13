/*
 * drag.js — one pointer drag, as a Mesa attachment.
 *
 *   <div {@attach drag(() => ({ start, move, end }))}>
 *
 *   accept(e)        → true to take this pointerdown (default: primary button)
 *   start(e)         → anything; handed back to `move` and `end` as `from`
 *   move(e, from, d) → `d` is `{ x, y }`, the distance from the press in CSS px
 *   end(e, from, { cancelled })
 *
 * A slider handle, a crop box, a splitter, a canvas pan, a signature pad. A
 * row moved between lists is `dnd.js`, which owns the placeholder and the
 * reorder; this owns the gesture and nothing else.
 *
 * The hand-written version gets three things wrong, and the copies this
 * replaced had each of them:
 *
 *   • ending on `mouseleave` or `pointerleave`, so the drag stops at the
 *     element's edge. Pointer capture keeps every move until the release,
 *     wherever the pointer goes.
 *   • no `pointercancel`. The browser takes a touch gesture for a scroll or a
 *     pinch and sends a cancel instead of an up; without a listener the drag
 *     is never ended and the next move carries on from a press long gone.
 *     `lostpointercapture` is the same end, reached when the capture is taken
 *     away.
 *   • mouse events, so a finger or a pen does nothing.
 *
 * The argument is a GETTER, as `dndzone`'s is: the options are read at each
 * event, so a callback sees the component's current state, and the attachment
 * is not rebuilt (and the drag dropped) when that state changes mid-drag.
 *
 * `{ first: true }` takes the press in the capture phase and stops it there,
 * so a drag on an ancestor can claim a press before the element under the
 * pointer sees it — Space-drag to pan over a crop box.
 */

/**
 * @param {() => {
 *   accept?: (e: PointerEvent) => boolean,
 *   start?:  (e: PointerEvent) => any,
 *   move?:   (e: PointerEvent, from: any, d: { x: number, y: number }) => void,
 *   end?:    (e: PointerEvent, from: any, info: { cancelled: boolean }) => void,
 * }} options
 * @param {{ first?: boolean }} [opts]
 */
export function drag(options, { first = false } = {}) {
  if (typeof options !== 'function') {
    throw new TypeError('drag: pass a getter — drag(() => ({ move, end })) — so a callback reads current state')
  }
  return (el) => {
    /** @type {{ id: number, x: number, y: number, from: any } | null} */
    let live = null

    function down(e) {
      const o = options()
      if (live || !(o.accept ? o.accept(e) : e.button === 0)) return
      e.preventDefault()
      if (first) e.stopPropagation()
      el.setPointerCapture(e.pointerId)
      live = { id: e.pointerId, x: e.clientX, y: e.clientY, from: o.start?.(e) }
    }
    function move(e) {
      if (!live || e.pointerId !== live.id) return
      options().move?.(e, live.from, { x: e.clientX - live.x, y: e.clientY - live.y })
    }
    function finish(e, cancelled) {
      if (!live || e.pointerId !== live.id) return
      const { from } = live
      live = null
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
      options().end?.(e, from, { cancelled })
    }
    const up     = (e) => finish(e, false)
    const cancel = (e) => finish(e, true)

    el.addEventListener('pointerdown', down, first)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', cancel)
    el.addEventListener('lostpointercapture', cancel)
    return () => {
      el.removeEventListener('pointerdown', down, first)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', cancel)
      el.removeEventListener('lostpointercapture', cancel)
    }
  }
}
