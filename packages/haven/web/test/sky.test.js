// web/test/sky.test.js — the sky (`IDEAS/haven.md` 7.2): a pure function of
// the clock, and a stage that reads it. Colors are asked of `stage.look()` at
// a given `ms`; what `#paint` draws is `look()`, so the two targets cannot
// disagree.
import { test, expect, setSystemTime } from 'bun:test'
import { createStage, INK, INDOORS } from '../src/stage.js'
import { piece } from '../src/pieces/index.js'
import { DAY_MS, SKY_MS, WEATHER_MS, FALL, darkness, isNight, shade, scheduleAt, weatherAt, fallAt, untilWeatherChange } from '../src/sky.js'
import { mountScene } from './stage.mjs'

const NOON = 0.25 * DAY_MS
const MIDNIGHT = 0.75 * DAY_MS

test('a day is daylight, a dusk that darkens in thirds, night, and a dawn that lightens', () => {
  expect(darkness(0)).toBe(0)
  expect(darkness(NOON)).toBe(0)
  expect(darkness(0.5 * DAY_MS)).toBe(0)
  expect([0.5, 0.52, 0.56, 0.59, 0.6].map((t) => darkness(t * DAY_MS))).toEqual([0, 1 / 3, 2 / 3, 1, 1])
  expect(darkness(MIDNIGHT)).toBe(1)
  expect([0.9, 0.92, 0.96, 0.99, 1].map((t) => darkness(t * DAY_MS))).toEqual([1, 2 / 3, 1 / 3, 0, 0])
  expect(darkness(MIDNIGHT + 5 * DAY_MS)).toBe(1)   // the same sky every day
  expect(darkness(-MIDNIGHT)).toBe(darkness(DAY_MS - MIDNIGHT))
  expect(isNight(MIDNIGHT)).toBe(true)
  expect(isNight(NOON)).toBe(false)
  expect(isNight(0.56 * DAY_MS)).toBe(false)
})

test('a shade keeps daylight as it was and takes the red out of night most', () => {
  expect(shade('#ffffff', 0)).toBe('#ffffff')
  expect(shade(undefined, 1)).toBeUndefined()
  expect(shade('#ffffff', 1)).toBe('#4d619e')
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(shade('#808080', 0.5).slice(i, i + 2), 16))
  expect(r).toBeLessThan(g)
  expect(g).toBeLessThan(b)
  expect(b).toBeLessThan(0x80)
})

const palette = {
  w: { fg: '#ffffff' },
  y: { fg: '#ffff00', light: 2 },
  k: { fg: ['#ffffff', '#cccccc'], chars: 'ab', ms: 100 },
}
const probe = (opts = {}) => {
  const stage = createStage({ slug: 'probe', palette, spawn: { x: 0, y: 0 }, ...opts })
  stage.stamp(piece('wall', '|', 'w'), 20, 5)
  stage.stamp(piece('lamp', 'o', 'y'), 4, 5)
  stage.stamp(piece('wall', '|', 'w'), 5, 5)
  stage.stamp(piece('water', '~', 'k'), 8, 5)
  stage.stamp(piece('post', '!', ' '), 22, 5)
  return stage
}

test('by day nothing is shaded; by night a cell is, a light source is not, and a lamp\'s pool keeps half of the day', () => {
  const stage = probe()
  expect(stage.look(20, 5, NOON)).toEqual({ ch: '|', fg: '#ffffff', bg: undefined })
  expect(stage.look(20, 5, MIDNIGHT)).toEqual({ ch: '|', fg: shade('#ffffff', 1), bg: undefined })
  expect(stage.look(22, 5, MIDNIGHT).fg).toBe(shade(INK, 1))              // the terminal's own ink too
  expect(stage.look(4, 5, MIDNIGHT).fg).toBe('#ffff00')                    // the lamp itself
  expect(stage.look(5, 5, MIDNIGHT).fg).toBe(shade('#ffffff', 0.5))        // beside it, in its pool
  expect(stage.look(5, 5, 0.52 * DAY_MS).fg).toBe(shade('#ffffff', 1 / 6)) // dusk, the pool a half of the sky's third
  expect(stage.look(8, 5, MIDNIGHT).ch === 'a' || stage.look(8, 5, MIDNIGHT).ch === 'b').toBe(true)
  expect(stage.look(8, 5, MIDNIGHT).fg).toMatch(/^#[0-9a-f]{6}$/)
})

test('an indoors stage has no sky, and a stage out of doors redraws on it', () => {
  const inside = probe({ layers: INDOORS })
  for (const ms of [NOON, MIDNIGHT]) expect(inside.look(20, 5, ms)).toEqual({ ch: '|', fg: '#ffffff', bg: undefined })
  expect(inside.tint('#123456', 20, 5, MIDNIGHT)).toBe('#123456')
  const quiet = createStage({ slug: 'quiet', palette: { w: { fg: '#fff' } }, spawn: { x: 0, y: 0 } })
  expect(quiet.tickOf(0.1 * WEATHER_MS)).toBe(SKY_MS)   // clear under the pin
  expect(createStage({ slug: 'quiet', palette: { w: { fg: '#fff' } }, spawn: { x: 0, y: 0 }, layers: INDOORS }).tickOf()).toBe(0)
})

test('a pacer is tinted by the sky and its own color is left alone by day', () => {
  const stage = probe()
  expect(stage.tint('#ffffff', 20, 5, NOON)).toBe('#ffffff')
  expect(stage.tint(undefined, 20, 5, NOON)).toBeUndefined()
  expect(stage.tint(undefined, 20, 5, MIDNIGHT)).toBe(shade(INK, 1))
  expect(stage.tint('#ffffff', 20, 5, MIDNIGHT)).toBe(shade('#ffffff', 1))
})

// A color the scene's own palette names, or the terminal's own ink: what a cell is when no sky touched it.
const named = (stage) => new Set([undefined, '#ffffff', ...Object.values(stage.palette).flatMap((p) => [p.fg, p.bg].flat())])

test('the real scenes: the square is shaded at night except its light sources; the tavern, the cellar and the workshop are not', async () => {
  // Mounted under a night clock, so `#paint` draws its pacers through the sky.
  setSystemTime(new Date(MIDNIGHT))
  const mounted = await mountScene('Square')
  setSystemTime()
  expect(mounted.frame.join('').trim()).not.toBe('')
  const square = mounted.stage
  const own = named(square)
  let shaded = 0
  for (let y = 0; y < square.height; y++) for (let x = 0; x < square.width; x++) {
    const night = square.look(x, y, MIDNIGHT)
    if (night.ch === ' ' || square.cycles(x, y)) continue
    expect(night.ch).toBe(square.look(x, y, NOON).ch)
    if (!own.has(night.fg)) shaded++
  }
  expect(shaded).toBeGreaterThan(500)
  const lit = square.lights[0]
  expect(own.has(square.look(lit.x, lit.y, MIDNIGHT).fg)).toBe(true)

  for (const name of ['Tavern', 'Cellar', 'Workshop']) {
    const stage = (await mountScene(name)).stage
    const own = named(stage)
    for (let y = 0; y < stage.height; y++) for (let x = 0; x < stage.width; x++) {
      const { ch, fg } = stage.look(x, y, MIDNIGHT)
      if (ch !== ' ') expect({ name, x, y, own: own.has(fg) }).toEqual({ name, x, y, own: true })
    }
  }
}, 30_000)

// ─── weather ──────────────────────────────────────────────────────────────

/** Run `fn` with the weather pinned (null: the clock's own), the pin put back after. */
const pinned = (kind, fn) => {
  const was = process.env.HAVEN_WEATHER
  if (kind === null) delete process.env.HAVEN_WEATHER; else process.env.HAVEN_WEATHER = kind
  try { return fn() } finally { if (was === undefined) delete process.env.HAVEN_WEATHER; else process.env.HAVEN_WEATHER = was }
}

test('the schedule is the clock\'s: spells of ten minutes, all three kinds, whatever the day', () => {
  const kinds = new Set()
  for (let spell = 0; spell < 60; spell++) {
    const ms = spell * WEATHER_MS
    expect(scheduleAt(ms)).toBe(scheduleAt(ms + WEATHER_MS - 1))
    kinds.add(scheduleAt(ms))
  }
  expect([...kinds].sort()).toEqual(['clear', 'rain', 'snow'])
  expect(scheduleAt(-1)).toMatch(/^(clear|rain|snow)$/)
})

test('a pin replaces the clock, a typo does not', () => {
  const ms = 3 * WEATHER_MS
  for (const k of ['clear', 'rain', 'snow']) pinned(k, () => expect(weatherAt(ms)).toBe(k))
  pinned('hail', () => expect(weatherAt(ms)).toBe(scheduleAt(ms)))
  pinned(null, () => expect(weatherAt(ms)).toBe(scheduleAt(ms)))
  pinned('rain', () => expect(untilWeatherChange(ms)).toBe(Infinity))
  pinned(null, () => expect(untilWeatherChange(ms + 1000)).toBe(WEATHER_MS - 1000))
})

/** The rows of column `x` that have a drop of `kind` at `ms`. */
const column = (kind, x, ms) => Array.from({ length: 80 }, (_, y) => y).filter((y) => fallAt(kind, x, y, ms))

test('a drop falls a row a step, a column has one a period, and a step is the same for every screen', () => {
  for (const kind of ['rain', 'snow']) {
    const { ms: step, period } = FALL[kind]
    const now = column(kind, 7, 10 * step)
    expect(now.length).toBeGreaterThanOrEqual(Math.floor(80 / period))
    expect(now.slice(1).map((y, i) => y - now[i])).toEqual(now.slice(1).map(() => period))
    expect(column(kind, 7, 10 * step + step - 1)).toEqual(now)              // within a step nothing moves
  }
  expect(fallAt('clear', 7, 3, 1234)).toBeNull()
})

test('rain falls straight and snow drifts a column every few steps', () => {
  const { ms: rain } = FALL.rain, { ms: snow, drift } = FALL.snow
  for (const y of column('rain', 20, 100 * rain)) expect(fallAt('rain', 20, y + 1, 101 * rain)).toBeTruthy()
  for (const y of column('snow', 20, 100 * snow)) {
    expect(fallAt('snow', 21, y + drift, (100 + drift) * snow)).toBeTruthy()   // a column right and a row a step lower, drift steps on
    expect(fallAt('snow', 20, y + 1, 101 * snow)).toBeTruthy()
  }
})

test('the density is a handful of cells in a screen, not a curtain', () => {
  const count = (kind) => Array.from({ length: 26 * 97 }, (_, i) => fallAt(kind, i % 97, Math.floor(i / 97), 5 * FALL[kind].ms)).filter(Boolean).length
  expect(count('rain')).toBeGreaterThan(100)
  expect(count('rain')).toBeLessThan(0.15 * 26 * 97)
  expect(count('snow')).toBeGreaterThan(50)
  expect(count('snow')).toBeLessThan(count('rain'))
})

test('weather falls on a blank outdoor cell and nowhere else: not a wall, a post, a lamp, a canopy, or indoors', () => {
  const stage = probe()
  stage.stamp(piece('canopy', ' ', ' ', { overhead: true }), 40, 5)
  const inside = probe({ layers: INDOORS })
  const cells = []
  for (let y = 0; y < 26; y++) for (let x = 0; x < 97; x++) cells.push([x, y])
  const claimedAt = (x, y) => inside.look(x, y, NOON).ch !== ' ' || (x === 40 && y === 5)

  pinned('rain', () => {
    const dropped = cells.filter(([x, y]) => stage.look(x, y, NOON).ch === "'")
    expect(dropped.length).toBeGreaterThan(100)
    for (const [x, y] of dropped) expect(claimedAt(x, y)).toBe(false)
    expect(stage.look(20, 5, NOON)).toEqual({ ch: '|', fg: '#ffffff', bg: undefined })
    expect(stage.look(22, 5, NOON).ch).toBe('!')
    expect(stage.look(4, 5, NOON).ch).toBe('o')
    expect(cells.some(([x, y]) => inside.look(x, y, NOON).ch === "'")).toBe(false)
    // the color is the rain's by day and the night's blue by night
    const [dx, dy] = dropped[0]
    expect(stage.look(dx, dy, NOON)).toEqual({ ch: "'", fg: FALL.rain.fg, bg: undefined })
    const night = cells.find(([x, y]) => stage.look(x, y, MIDNIGHT).ch === "'" && !claimedAt(x, y))
    expect([shade(FALL.rain.fg, 1), shade(FALL.rain.fg, 0.5)]).toContain(stage.look(...night, MIDNIGHT).fg)
  })
  pinned('snow', () => expect(cells.filter(([x, y]) => stage.look(x, y, NOON).ch === '*').length).toBeGreaterThan(50))
  pinned('clear', () => expect(cells.every(([x, y]) => stage.look(x, y, NOON).ch !== "'" && stage.look(x, y, NOON).ch !== '*')).toBe(true))
})

test('the stage redraws on the fall while it falls, and on the edge of a spell when it does not', () => {
  const stage = createStage({ slug: 'weathered', palette: { w: { fg: '#fff' } }, spawn: { x: 0, y: 0 } })
  pinned('rain', () => expect(stage.tickOf(0)).toBe(FALL.rain.ms))
  pinned('snow', () => expect(stage.tickOf(0)).toBe(Math.min(SKY_MS, FALL.snow.ms)))
  pinned('clear', () => expect(stage.tickOf(0)).toBe(SKY_MS))
  const spell = [...Array(60).keys()].map((i) => i * WEATHER_MS).find((ms) => scheduleAt(ms) === 'clear')
  pinned(null, () => {
    expect(stage.tickOf(spell + WEATHER_MS - 1000)).toBe(Math.min(SKY_MS, 1000, ...(FALL[scheduleAt(spell)] ? [FALL[scheduleAt(spell)].ms] : [])))
    expect(stage.tickOf(spell)).toBe(SKY_MS)
  })
  expect(createStage({ slug: 'indoor', palette: {}, spawn: { x: 0, y: 0 }, layers: INDOORS }).tickOf(0)).toBe(0)
})

test('the real square in the rain: the terminal draws drops on the blank cells and every other glyph as it was', async () => {
  const clear = await mountScene('Square')
  process.env.HAVEN_WEATHER = 'rain'
  const wet = await mountScene('Square')
  process.env.HAVEN_WEATHER = 'clear'
  const v = clear.stage.view
  const moving = (x, y) => clear.stage.cycles(v.x + x, v.y + y) || clear.stage.pacers.some((p) => p.y === v.y + y)
  let drops = 0
  clear.frame.forEach((row, y) => [...row].forEach((ch, x) => {
    const w = wet.frame[y]?.[x] ?? ' '
    if (moving(x, y)) return
    if (ch === ' ') { if (w === "'") drops++; else expect(w).toBe(' ') } else expect(w).toBe(ch)
  }))
  expect(drops).toBeGreaterThan(50)
}, 30_000)
