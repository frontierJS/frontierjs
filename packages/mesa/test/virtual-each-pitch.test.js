/**
 * virtual-each-pitch.test.js
 *
 * FJS-3740 -- {#virtual each} took ONE row's height as the pitch of every row.
 * A first row taller than the rest (a header-like row) made the spacers, and so
 * the scroll extent, a multiple of the wrong number.
 *
 * FJS-4210 -- a horizontal-only scroll requested a frame and re-rendered the
 * window. A frame asked for from a scroll event keeps the browser's frame clock
 * running, so a keystroke that scrolled a long line sideways painted a frame late.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { $$virtualEach, createSignal, flushSync } from '../src/runtime.js'
import { clock } from '../src/clock.js'

const realRect = Element.prototype.getBoundingClientRect

// A stand-in for layout: a row's height is its data-h, its top is the sum of
// the heights of the siblings before it (spacers carry theirs inline).
function fakeLayout() {
  const hOf = (el) => el.dataset?.h ? Number(el.dataset.h) : parseFloat(el.style?.height) || 0
  Element.prototype.getBoundingClientRect = function () {
    let top = 0
    for (let n = this.previousElementSibling; n; n = n.previousElementSibling) top += hOf(n)
    const height = hOf(this)
    return { top, bottom: top + height, left: 0, right: 0, width: 0, height }
  }
}

beforeEach(() => { document.body.innerHTML = ''; fakeLayout() })
afterEach(() => { Element.prototype.getBoundingClientRect = realRect })

function mountList(n, heightOf) {
  const scroller = document.createElement('div')
  scroller.style.overflowY = 'auto'
  Object.defineProperty(scroller, 'clientHeight', { value: 500 })
  document.body.appendChild(scroller)
  const rows = Array.from({ length: n }, (_, i) => ({ id: i }))
  const [get] = createSignal(rows)
  $$virtualEach(scroller, get, (r) => r.id, (getItem, getIndex) => {
    const el = document.createElement('div')
    el.dataset.h = String(heightOf(getIndex()))
    return el
  })
  flushSync()
  return scroller
}

describe('{#virtual each} pitch', () => {
  it('a taller first row does not set the pitch of the rest', () => {
    const scroller = mountList(500, (i) => (i === 0 ? 80 : 51))
    const [top, bot] = [scroller.firstElementChild, scroller.lastElementChild]
    const drawn = [...scroller.children].filter((c) => c.dataset.h).length
    const total = parseFloat(top.style.height) + parseFloat(bot.style.height)
    // spacers stand for the (500 - drawn) rows not drawn, each at the pitch
    expect(total / (500 - drawn)).toBeCloseTo(51, 0)
  })
})

describe('{#virtual each} scroll', () => {
  it('a horizontal-only scroll requests no frame; a vertical one requests one', () => {
    const frames = []
    const prev = clock.use({
      now: () => 0,
      after: () => () => {},
      every: () => () => {},
      frame: (fn, label) => { frames.push(label); return () => {} },
    })
    try {
      const scroller = mountList(500, () => 20)
      let top = 0
      Object.defineProperty(scroller, 'scrollTop', { get: () => top, set: (v) => { top = v } })
      frames.length = 0
      scroller.scrollLeft = 40
      scroller.dispatchEvent(new Event('scroll'))
      expect(frames).toEqual([])
      top = 2000
      scroller.dispatchEvent(new Event('scroll'))
      expect(frames).toEqual(['virtual list scroll'])
    } finally {
      clock.use(prev)
    }
  })
})
