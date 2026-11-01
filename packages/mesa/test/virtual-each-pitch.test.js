/**
 * virtual-each-pitch.test.js
 *
 * FJS-3740 -- {#virtual each} took ONE row's height as the pitch of every row.
 * A first row taller than the rest (a header-like row) made the spacers, and so
 * the scroll extent, a multiple of the wrong number.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { $$virtualEach, createSignal, flushSync } from '../src/runtime.js'

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
