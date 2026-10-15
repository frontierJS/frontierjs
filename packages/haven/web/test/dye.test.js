// web/test/dye.test.js — a figure stepping into the square's flowers takes the
// color the flower is drawn in at that moment (`dyeAt`, a palette entry's
// `dye`), and only a flower dyes.
import { test, expect } from 'bun:test'
import { mountScene } from './stage.mjs'
import { DAY_MS } from '../src/sky.js'

const { stage } = await mountScene('Square')
const FLOWER = { x: 6, y: 24 }
const HEDGE  = { x: 5, y: 23 }
const NOON   = 3 * DAY_MS + DAY_MS * 0.25
const NIGHT  = 3 * DAY_MS + DAY_MS * 0.75

test('a flower dyes in the color it is drawn in, and it changes on the clock', () => {
  const seen = new Set()
  for (let i = 0; i < 40; i++) {
    const ms = NOON + i * 1500
    const dye = stage.dyeAt(FLOWER.x, FLOWER.y, ms)
    expect(dye).toBe(stage.look(FLOWER.x, FLOWER.y, ms).fg)
    seen.add(dye)
  }
  expect(seen.size).toBeGreaterThan(1)
})

test('a flower picked at night is its daytime color, not the moonlit one', () => {
  const dye = stage.dyeAt(FLOWER.x, FLOWER.y, NIGHT)
  expect(['#f472b6', '#facc15', '#c084fc', '#fb7185']).toContain(dye)
  expect(stage.look(FLOWER.x, FLOWER.y, NIGHT).fg).not.toBe(dye)
})

test('a hedge, a blank cell and the spawn dye nothing', () => {
  expect(stage.dyeAt(HEDGE.x, HEDGE.y, NOON)).toBeNull()
  expect(stage.dyeAt(FLOWER.x + 1, FLOWER.y, NOON)).toBeNull()
  expect(stage.dyeAt(31, 21, NOON)).toBeNull()
})
