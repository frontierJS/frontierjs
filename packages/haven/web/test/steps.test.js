// web/test/steps.test.js
// Footprints (`IDEAS/haven.md` 7.4) as the `steps` layer draws them: a `.` on
// a blank cell somebody stood on, fading in thirds of its life and gone after,
// never on the art, under a falling drop, shaded by the night, and a redraw
// at each third on the stage's clock.
import { test, expect } from 'bun:test'
import { createStage, STEP_FG, INDOORS, OUTDOORS } from '../src/stage.js'
import { piece } from '../src/pieces/index.js'
import { DAY_MS, FALL, fallAt, shade } from '../src/sky.js'
import { TRACES } from '../../api/src/memory.ts'

const LIFE = TRACES.step.ms
const NOON = 3 * DAY_MS + 1000

const probe = (opts = {}) => {
  const stage = createStage({ slug: 'steps', palette: { w: { fg: '#ffffff' } }, spawn: { x: 0, y: 0 }, manual: true, ...opts })
  stage.stamp(piece('wall', '|', 'w'), 9, 0)
  return stage
}
const trace = (x, y, at = NOON) => ({ x, y, at, until: at + LIFE })

test('a footprint is a dot on the cell, brightest first, a third of its life a shade, and gone at its end', () => {
  const stage = probe()
  stage.tread([trace(3, 0)])
  expect(stage.look(3, 0, NOON)).toEqual({ ch: '.', fg: STEP_FG[2], bg: undefined })
  expect(stage.look(3, 0, NOON + LIFE / 3 + 1).fg).toBe(STEP_FG[1])
  expect(stage.look(3, 0, NOON + (2 * LIFE) / 3 + 1).fg).toBe(STEP_FG[0])
  expect(stage.look(3, 0, NOON + LIFE).ch).toBe(' ')
  expect(stage.look(4, 0, NOON).ch).toBe(' ')       // the cell beside it was walked by nobody
})

test('a newer footprint on a cell is the one drawn, and an older one laid after it changes nothing', () => {
  const stage = probe()
  stage.tread([trace(3, 0, NOON)])
  stage.tread([trace(3, 0, NOON + (2 * LIFE) / 3)])
  expect(stage.look(3, 0, NOON + (2 * LIFE) / 3 + 1).fg).toBe(STEP_FG[2])
  stage.tread([trace(3, 0, NOON)])
  expect(stage.look(3, 0, NOON + (2 * LIFE) / 3 + 1).fg).toBe(STEP_FG[2])
})

test('a footprint never covers the art, is in the tavern as on the square, and is not there with the layer unnamed', () => {
  const stage = probe()
  stage.tread([trace(9, 0)])
  expect(stage.look(9, 0, NOON).ch).toBe('|')
  const inside = probe({ layers: INDOORS })
  inside.tread([trace(3, 0)])
  expect(inside.look(3, 0, NOON).ch).toBe('.')
  const bare = probe({ layers: OUTDOORS.filter((l) => l !== 'steps') })
  bare.tread([trace(3, 0)])
  expect(bare.look(3, 0, NOON).ch).toBe(' ')
})

test('a drop falls in front of a footprint, and the night shades it', () => {
  const prev = import.meta.env.HAVEN_WEATHER
  import.meta.env.HAVEN_WEATHER = 'rain'
  try {
    const stage = probe()
    let ms = NOON
    while (!fallAt('rain', 3, 0, ms)) ms += FALL.rain.ms
    stage.tread([trace(3, 0, ms)])
    expect(stage.look(3, 0, ms).ch).toBe(FALL.rain.ch)
  } finally { import.meta.env.HAVEN_WEATHER = prev }
  const stage = probe()
  const midnight = 3 * DAY_MS + 0.75 * DAY_MS
  stage.tread([trace(3, 0, midnight)])
  expect(stage.look(3, 0, midnight).fg).toBe(shade(STEP_FG[2], 1))
})

test('the clock wakes a screen at each third of a footprint and lets it go at its end', () => {
  const stage = probe({ layers: INDOORS })
  const painted = []
  stage.task('paint', (ms) => painted.push(ms), { phase: 'paint' })
  expect(stage.tickOf(NOON)).toBe(0)                      // nothing moves indoors with no footprint
  stage.frame(NOON)
  stage.tread([trace(3, 0)])
  expect(painted.at(-1)).toBe(NOON)                       // a footprint laid paints at once
  expect(stage.tickOf(NOON)).toBe(Math.ceil(LIFE / 3))
  for (let ms = NOON; ms <= NOON + LIFE + 1000; ms += 1000) stage.frame(ms)
  const thirds = painted.filter((ms) => ms > NOON)
  expect(thirds.length).toBe(3)                           // two shades and the going
  expect(stage.look(3, 0, NOON + LIFE).ch).toBe(' ')
  expect(stage.tickOf(NOON + LIFE + 1000)).toBe(0)
})
