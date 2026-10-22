/*
 * tty.spec.js — the tone table. That the names match `tones.css` is mesa's
 * `terminal-tags.test.js`; this pins the shape a terminal reads.
 */

import { TONES, toneOf } from '../../src/tty/tty.js'

test('tty: every tone is a palette index in the 16 colors, or dim', function () {
  for (const [name, t] of Object.entries(TONES)) {
    if (t.dim) assert.equal(t.color, undefined, `${name} is dim and has a color`)
    else assert.ok(Number.isInteger(t.color) && t.color >= 0 && t.color < 16, `${name}: ${t.color}`)
  }
})

test('tty: no two hued tones share a color', function () {
  const colors = Object.values(TONES).filter((t) => !t.dim).map((t) => t.color)
  assert.equal(new Set(colors).size, colors.length)
})

test('tty: toneOf reads the first tone in a class attribute', function () {
  assert.equal(toneOf('btn primary'), 'primary')
  assert.equal(toneOf('alert danger warning'), 'danger')
  assert.equal(toneOf('card raised'), null)
  assert.equal(toneOf('text-muted'), null)
  assert.equal(toneOf('constructor'), null)
  assert.equal(toneOf(null), null)
})
