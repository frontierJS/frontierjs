/*
 * place-against.mjs
 * `placeAgainst` — a top/bottom panel that fits neither side of its trigger.
 * FJS-4063: it kept the preferred side and ran past the window's edge.
 *
 * Run: node test/place-against.mjs
 */
import assert from 'node:assert/strict'

const { placeAgainst } = await import('../utils.js')

const vp = { width: 1000, height: 800 }
const box = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height })
const results = []
function check(label, fn) {
  try { fn(); results.push([label, null]) } catch (e) { results.push([label, e]) }
}

// 60 rows of 32px: taller than the window, so neither side holds it.
const tall = box(0, 0, 200, 1920)

check('fits below: opens below, no cap', () => {
  const r = placeAgainst(box(10, 100, 80, 30), box(0, 0, 200, 200), vp)
  assert.equal(r.y, 134)
  assert.equal(r.maxHeight, undefined)
})

check('fits only above: flips, no cap', () => {
  const r = placeAgainst(box(10, 700, 80, 30), box(0, 0, 200, 300), vp)
  assert.equal(r.y, 700 - 300 - 4)
  assert.equal(r.maxHeight, undefined)
})

check('fits neither, more room below: takes below and caps to it', () => {
  const r = placeAgainst(box(10, 100, 80, 30), tall, vp)
  assert.equal(r.y, 134)
  assert.equal(r.maxHeight, 800 - 134 - 8)
  assert.ok(r.y + r.maxHeight <= vp.height)
})

check('fits neither, more room above: takes above and caps to it', () => {
  const r = placeAgainst(box(10, 600, 80, 30), tall, vp)
  assert.equal(r.maxHeight, 600 - 4 - 8)
  assert.equal(r.y, 600 - 4 - r.maxHeight)
  assert.ok(r.y >= 0)
})

check('top-start preference gives way to the side with more room', () => {
  const r = placeAgainst(box(10, 100, 80, 30), tall, vp, { placement: 'top-start' })
  assert.equal(r.y, 134)
  assert.equal(r.maxHeight, 800 - 134 - 8)
})

let failed = 0
for (const [label, e] of results) {
  console.log(`${e ? '✗' : '✓'} ${label}`)
  if (e) { failed++; console.log(`    ${e.message.split('\n')[0]}`) }
}
process.exit(failed ? 1 : 0)
