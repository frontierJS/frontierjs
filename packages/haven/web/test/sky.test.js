// web/test/sky.test.js — the sky (`IDEAS/haven.md` 7.2): a pure function of
// the clock, and a stage that reads it. Colors are asked of `stage.look()` at
// a given `ms`; what `#paint` draws is `look()`, so the two targets cannot
// disagree.
import { test, expect, setSystemTime } from 'bun:test'
import { createStage, INK, INDOORS, OUTDOORS, MOON_ROW } from '../src/lib/scene/stage.js'
import { piece } from '../src/pieces/index.js'
import { DAY_MS, SKY_MS, WEATHER_MS, FALL, DROPS, GUST, GROUND, GROUND_MS, tempAt, groundAt, groundOn, darkness, isNight, shade, moonAt, MOON_FG, SYNODIC_MS, scheduleAt, seasonAt, almanacAt, windAt, heldOf, fallAt, cloudAt, CLOUD_MS, untilWeatherChange } from '#shared/sky.js'
import { hold } from '../src/lib/sky/held.js'
import { mountScene } from './stage.mjs'

const NOON = 0.25 * DAY_MS
const MIDNIGHT = 0.75 * DAY_MS
const MOON = moonAt(MIDNIGHT).light

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
  expect(shade('#ffffff', 0, 0.5)).toBe('#ffffff')
  expect(shade(undefined, 1, 0.5)).toBeUndefined()
  expect(shade('#ffffff', 1, 0.5)).toBe('#4d619e')
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(shade('#808080', 0.5, 0.5).slice(i, i + 2), 16))
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
  expect(stage.look(20, 5, MIDNIGHT)).toEqual({ ch: '|', fg: shade('#ffffff', 1, MOON), bg: undefined })
  expect(stage.look(22, 5, MIDNIGHT).fg).toBe(shade(INK, 1, MOON))        // the terminal's own ink too
  expect(stage.look(4, 5, MIDNIGHT).fg).toBe('#ffff00')                    // the lamp itself
  const red = (hex) => parseInt(hex.slice(1, 3), 16)
  const blue = (hex) => parseInt(hex.slice(5, 7), 16)
  const pooled = stage.look(5, 5, MIDNIGHT)                                  // beside it, in its pool
  expect(red(pooled.fg)).toBeGreaterThan(red(shade('#ffffff', 0.5, MOON)))   // warmed toward the lamp's amber
  expect(blue(pooled.fg)).toBeLessThan(blue(shade('#ffffff', 0.5, MOON)))
  expect(stage.look(6, 5, MIDNIGHT)).toEqual({ ch: ' ', fg: undefined, bg: expect.stringMatching(/^#[0-9a-f]{6}$/) })   // and a blank cell in it is lit too
  expect(stage.look(12, 5, MIDNIGHT)).toEqual({ ch: ' ', fg: undefined, bg: undefined })                              // past its radius it is not
  expect(stage.look(6, 5, NOON).bg).toBeUndefined()                         // by day there is no glow
  expect(stage.look(8, 5, MIDNIGHT).ch === 'a' || stage.look(8, 5, MIDNIGHT).ch === 'b').toBe(true)
  expect(stage.look(8, 5, MIDNIGHT).fg).toMatch(/^#[0-9a-f]{6}$/)
})

test('an indoors stage has no sky, and a stage out of doors redraws on it', () => {
  const inside = probe({ layers: INDOORS })
  for (const ms of [NOON, MIDNIGHT]) expect(inside.look(20, 5, ms)).toEqual({ ch: '|', fg: '#ffffff', bg: undefined })
  expect(inside.tint('#123456', 20, 5, MIDNIGHT)).toBe('#123456')
  const quiet = createStage({ slug: 'quiet', palette: { w: { fg: '#fff' } }, spawn: { x: 0, y: 0 } })
  expect(quiet.tickOf(0.1 * WEATHER_MS)).toBe(SKY_MS - 0.1 * WEATHER_MS)   // to the sky's next step, clear under the pin
  expect(quiet.tickOf(3 * SKY_MS)).toBe(SKY_MS)
  expect(createStage({ slug: 'quiet', palette: { w: { fg: '#fff' } }, spawn: { x: 0, y: 0 }, layers: INDOORS }).tickOf()).toBe(0)
})

test('a pacer is tinted by the sky and its own color is left alone by day', () => {
  const stage = probe()
  expect(stage.tint('#ffffff', 20, 5, NOON)).toBe('#ffffff')
  expect(stage.tint(undefined, 20, 5, NOON)).toBeUndefined()
  expect(stage.tint(undefined, 20, 5, MIDNIGHT)).toBe(shade(INK, 1, MOON))
  expect(stage.tint('#ffffff', 20, 5, MIDNIGHT)).toBe(shade('#ffffff', 1, MOON))
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
    if (night.ch === ' ' || night.fg === MOON_FG || square.cycles(x, y)) continue
    expect(night.ch).toBe(square.look(x, y, NOON).ch)
    if (!own.has(night.fg)) shaded++
  }
  expect(shaded).toBeGreaterThan(500)
  const lit = square.lights[0]
  expect(own.has(square.look(lit.x, lit.y, MIDNIGHT).fg)).toBe(true)

  for (const name of ['Tavern', 'Cellar', 'Workshop']) {
    const stage = (await mountScene(name)).stage
    const own = named(stage)
    // The cellar names `lamplight`, whose pool is warm at every hour; the night is what is asked here.
    const pooled = (x, y) => stage.lights.some((l) => ((l.x - x) / 2) ** 2 + (l.y - y) ** 2 <= l.r * l.r)
    for (let y = 0; y < stage.height; y++) for (let x = 0; x < stage.width; x++) {
      const { ch, fg } = stage.look(x, y, MIDNIGHT)
      if (ch !== ' ' && !pooled(x, y)) expect({ name, x, y, own: own.has(fg) }).toEqual({ name, x, y, own: true })
    }
  }
}, 30_000)

// ─── the moon ─────────────────────────────────────────────────────────────

// Phases read off the real calendar: the full moon of 2026-10-26 and the new moon of 2026-10-10.
const FULL = Date.UTC(2026, 9, 26, 4)
const NEW  = Date.UTC(2026, 9, 11, 0)
/** `day` at the hour-long day's `t`: the moon's date kept, the night's hour chosen. */
const at = (day, t) => day - (((day % DAY_MS) + DAY_MS) % DAY_MS) + t * DAY_MS

test('the moon keeps the real date: full on 2026-10-26, new on 2026-10-10, a quarter between', () => {
  expect(moonAt(FULL)).toMatchObject({ light: 1, ch: 'O' })
  expect(moonAt(NEW)).toMatchObject({ light: 0, ch: null })
  expect(moonAt(Date.UTC(2026, 9, 18, 12))).toMatchObject({ light: 0.5, ch: 'D' })   // waxing, lit on the right
  expect(moonAt(Date.UTC(2026, 10, 2, 12))).toMatchObject({ light: 0.5, ch: 'C' })   // waning
  expect(moonAt(FULL + SYNODIC_MS).light).toBe(1)
  expect(Math.abs(moonAt(FULL).phase - 0.5)).toBeLessThan(0.02)
  expect(moonAt(FULL).phase).toBeCloseTo(moonAt(FULL + DAY_MS / 2).phase, 2)      // half an hour-long day moves it half an hour's worth
})

test('the moon is up through full night only, rising east and setting west a sky step at a time', () => {
  for (const t of [0.25, 0.55, 0.95]) expect(moonAt(at(FULL, t)).arc).toBeNull()
  expect(moonAt(at(FULL, 0.6)).arc).toBe(0)
  expect(moonAt(at(FULL, 0.75)).arc).toBe(0.5)
  expect(moonAt(at(FULL, 0.899)).arc).toBe(1)
  expect(moonAt(at(FULL, 0.6) + SKY_MS - 1).arc).toBe(0)
  expect(moonAt(at(FULL, 0.6) + SKY_MS).arc).toBeGreaterThan(0)
})

test('a full moon lightens the night and a new moon darkens it', () => {
  const lum = (hex) => [1, 3, 5].reduce((n, i) => n + parseInt(hex.slice(i, i + 2), 16), 0)
  expect(lum(shade('#c8c8c8', 1, 1))).toBeGreaterThan(lum(shade('#c8c8c8', 1, 0.5)))
  expect(lum(shade('#c8c8c8', 1, 0))).toBeLessThan(lum(shade('#c8c8c8', 1, 0.5)))
  const stage = probe()
  expect(stage.look(20, 5, at(FULL, 0.75)).fg).toBe(shade('#ffffff', 1, 1))
  expect(stage.look(20, 5, at(NEW, 0.75)).fg).toBe(shade('#ffffff', 1, 0))
  expect(stage.tint('#ffffff', 20, 5, at(FULL, 0.75))).toBe(shade('#ffffff', 1, 1))
})

test('the square: the moon crosses its sky row on a blank cell at night, east to west, and never by day, at new moon or indoors', async () => {
  const square = (await mountScene('Square')).stage
  const moons = (ms) => {
    const found = []
    for (let y = 0; y < square.height; y++) for (let x = 0; x < square.width; x++) {
      const c = square.look(x, y, ms)
      if (c.fg === MOON_FG) found.push({ x, y, ch: c.ch })
    }
    return found
  }
  const rise = moons(at(FULL, 0.6))
  const high = moons(at(FULL, 0.75))
  expect(high).toEqual([{ x: high[0].x, y: MOON_ROW, ch: 'O' }])
  expect(rise.length <= 1 && (!rise[0] || rise[0].x > high[0].x)).toBe(true)   // risen in the east, or behind a chimney there
  expect(square.look(high[0].x, MOON_ROW, at(FULL, 0.25)).ch).toBe(' ')         // by day the cell is blank sky
  expect(moons(at(FULL, 0.25))).toEqual([])
  expect(moons(at(NEW, 0.75))).toEqual([])
  const tavern = (await mountScene('Tavern')).stage
  for (let x = 0; x < tavern.width; x++) expect(tavern.look(x, MOON_ROW, at(FULL, 0.75)).fg).not.toBe(MOON_FG)
}, 30_000)

// ─── weather ──────────────────────────────────────────────────────────────

/** Run `fn` with the weather pinned (null: the clock's own), the pin put back after. */
const pinned = (kind, fn) => {
  const was = process.env.HAVEN_WEATHER
  if (kind === null) delete process.env.HAVEN_WEATHER; else process.env.HAVEN_WEATHER = kind
  try { return fn() } finally { if (was === undefined) delete process.env.HAVEN_WEATHER; else process.env.HAVEN_WEATHER = was }
}

test('the season is the real one, by the UTC month, meteorological and northern', () => {
  const at = (iso) => seasonAt(Date.parse(iso))
  expect(['2026-12-01T00:00Z', '2027-01-15T12:00Z', '2027-02-28T23:59Z'].map(at)).toEqual(['winter', 'winter', 'winter'])
  expect(['2026-03-01T00:00Z', '2026-05-31T23:59Z'].map(at)).toEqual(['spring', 'spring'])
  expect(['2026-06-01T00:00Z', '2026-08-31T23:59Z'].map(at)).toEqual(['summer', 'summer'])
  expect(['2026-09-01T00:00Z', '2026-11-30T23:59Z'].map(at)).toEqual(['fall', 'fall'])
  // UTC, whatever the host: the first minute of March in UTC is still February west of it.
  expect(at('2026-02-28T23:30-01:00')).toBe('spring')
})

/** The kinds the clock schedules over `n` spells from `from`, with a count of each. */
const spells = (from, n = 600) => {
  const count = {}
  for (let i = 0; i < n; i++) {
    const ms = Date.parse(from) + i * WEATHER_MS
    expect(scheduleAt(ms)).toBe(scheduleAt(ms + WEATHER_MS - 1))
    count[scheduleAt(ms)] = (count[scheduleAt(ms)] ?? 0) + 1
  }
  return count
}

test('the schedule is the clock\'s, spells of ten minutes weighted by the season', () => {
  const [spring, summer, fall, winter] = ['2026-04-01T00:00Z', '2026-07-01T00:00Z', '2026-10-01T00:00Z', '2027-01-01T00:00Z'].map((d) => spells(d))
  expect(winter.storm).toBeUndefined()
  expect(summer.storm).toBeGreaterThan(spring.storm)                      // storms mostly summer
  expect(summer.storm).toBeGreaterThan(fall.storm)
  for (const s of [spring, fall]) expect(s.rain).toBeGreaterThan(summer.rain)   // rain mostly spring and fall
  expect(Object.keys({ ...spring, ...summer, ...fall, ...winter }).sort()).toEqual(['clear', 'rain', 'storm'])   // snow is the temperature's
  expect(scheduleAt(-1)).toMatch(/^(clear|rain|storm)$/)
})

// ─── temperature and aftermath ────────────────────────────────────────────

/** What falls over a day of real time from `from`, a count of each, the clock's. */
const falls = (from) => pinned(null, () => {
  const count = {}
  for (let i = 0; i < 720; i++) {
    const w = almanacAt(Date.parse(from) + i * SKY_MS).weather
    count[w] = (count[w] ?? 0) + 1
  }
  return count
})

test('the temperature is the season\'s, warmer by day, colder under cloud, and a cold rain spell falls as snow', () => {
  const day = Date.parse('2027-01-10T00:00Z')
  expect(Number.isInteger(tempAt(day))).toBe(true)
  // the spell from half past the hour holds the dusk: its light and its full night are the hour's eight degrees apart
  expect(Math.floor(at(day, 0.5) / WEATHER_MS)).toBe(Math.floor(at(day, 0.65) / WEATHER_MS))
  expect(tempAt(at(day, 0.5)) - tempAt(at(day, 0.65))).toBe(8)
  expect(tempAt(at(day, 0.25))).toBe(tempAt(at(day, 0.25) + SKY_MS))         // the day's hours are one temperature
  const mean = (iso) => { let n = 0; for (let i = 0; i < 720; i++) n += tempAt(Date.parse(iso) + i * SKY_MS); return n / 720 }
  expect(mean('2026-07-10T00:00Z')).toBeGreaterThan(mean('2026-04-10T00:00Z'))
  expect(mean('2026-04-10T00:00Z')).toBeGreaterThan(mean('2027-01-10T00:00Z'))
  // what falls: snow in winter and never in summer, and only ever from a rain spell at or below freezing
  expect(falls('2027-01-10T00:00Z').snow).toBeGreaterThan(50)
  expect(falls('2026-07-10T00:00Z').snow).toBeUndefined()
  pinned(null, () => {
    for (let i = 0; i < 2000; i++) {
      const ms = Date.parse('2027-01-10T00:00Z') + i * SKY_MS
      const w = almanacAt(ms).weather
      if (w === 'snow') { expect(scheduleAt(ms)).toBe('rain'); expect(tempAt(ms)).toBeLessThanOrEqual(0) }
      if (w === 'rain') expect(tempAt(ms)).toBeGreaterThan(0)
    }
  })
})

/** The first SKY_MS step from `from` at which `fn(ms)` holds, or null. */
const first = (from, fn) => {
  for (let i = 0; i < 20_000; i++) if (fn(from + i * SKY_MS)) return from + i * SKY_MS
  return null
}

test('the ground keeps what fell: puddles dry within minutes of the rain, a cover builds while it snows and thaws above freezing', () => pinned(null, () => {
  const spring = Date.parse('2026-04-10T00:00Z')
  // the step a rain spell ends on: wet then, dry four steps later unless it rained again
  const after = first(spring, (ms) => scheduleAt(ms - SKY_MS) === 'rain' && scheduleAt(ms) === 'clear' && almanacAt(ms - SKY_MS).weather === 'rain')
  expect(groundAt(after - SKY_MS).wet).toBe(1)
  const dried = [0, 1, 2, 3].map((n) => groundAt(after + n * SKY_MS).wet)
  if ([0, 1, 2, 3].every((n) => scheduleAt(after + n * SKY_MS) === 'clear')) expect(dried).toEqual([0.75, 0.5, 0.25, 0])
  // a snowfall: the cover grows a third a step while it falls and does not thaw then
  const winter = Date.parse('2027-01-10T00:00Z')
  const fall = first(winter, (ms) => almanacAt(ms).weather === 'snow' && almanacAt(ms - SKY_MS).weather !== 'snow' && groundAt(ms - SKY_MS).snow === 0)
  expect(groundAt(fall).snow).toBeCloseTo(1 / 3)
  if (almanacAt(fall + SKY_MS).weather === 'snow') expect(groundAt(fall + SKY_MS).snow).toBeCloseTo(2 / 3)
  // a thaw: a covered step followed by a warm dry one loses a tenth a degree
  const thaw = first(winter, (ms) => groundAt(ms - SKY_MS).snow > 0 && almanacAt(ms).weather !== 'snow' && tempAt(ms) > 0)
  expect(thaw).not.toBeNull()
  expect(groundAt(thaw).snow).toBeCloseTo(Math.max(0, groundAt(thaw - SKY_MS).snow - tempAt(thaw) / 10))
  const hard = first(winter, (ms) => groundAt(ms - SKY_MS).snow > 0 && almanacAt(ms).weather === 'clear' && tempAt(ms) <= 0)
  expect(hard).not.toBeNull()
  expect(groundAt(hard).snow).toBe(groundAt(hard - SKY_MS).snow)            // a frost keeps it
  // the ground changes only on a sky step, and remembers GROUND_MS
  expect(groundAt(after + SKY_MS - 1)).toEqual(groundAt(after))
  expect(GROUND_MS).toBe(DAY_MS)
}))

test('a held weather is a weather the ground has always had: clear is bare, rain is wet, snow is covered', () => {
  const ms = Date.parse('2026-07-10T12:00Z')
  expect(groundAt(ms, { weather: 'clear' })).toEqual({ wet: 0, snow: 0 })
  expect(groundAt(ms, { weather: 'rain' })).toEqual({ wet: 1, snow: 0 })
  expect(groundAt(ms, { weather: 'snow' })).toEqual({ wet: 0, snow: 1 })   // a summer's day: nothing thaws while it falls
})

test('the ground is drawn on a blank lit outdoor cell, fewer cells as it fades, behind a drop, and never indoors', () => {
  const cells = []
  for (let y = 0; y < 26; y++) for (let x = 0; x < 97; x++) cells.push([x, y])
  const share = (kind, ground) => cells.filter(([x, y]) => groundOn(x, y, ground)?.ch === GROUND[kind].ch).length / cells.length
  expect(share('wet', { wet: 1, snow: 0 })).toBeCloseTo(GROUND.wet.share, 1)
  expect(share('snow', { wet: 0, snow: 1 })).toBeCloseTo(GROUND.snow.share, 1)
  expect(share('snow', { wet: 0, snow: 1 / 3 })).toBeLessThan(share('snow', { wet: 0, snow: 1 }))
  expect(share('wet', { wet: 0, snow: 0 }) + share('snow', { wet: 0, snow: 0 })).toBe(0)
  try {
    hold('weather', 'snow')
    const stage = probe(), inside = probe({ layers: INDOORS })
    const covered = cells.filter(([x, y]) => stage.look(x, y, NOON).ch === GROUND.snow.ch)
    expect(covered.length).toBeGreaterThan(cells.length / 4)
    for (const [x, y] of covered) {
      expect(inside.look(x, y, NOON).ch).toBe(' ')                                // a blank cell, and indoors there is none
      expect(fallAt('snow', x, y, NOON, windAt(NOON))).toBeNull()                 // a drop is drawn in front of it
    }
    expect(stage.look(20, 5, NOON).ch).toBe('|')
    expect(cells.some(([x, y]) => inside.look(x, y, NOON).ch === GROUND.snow.ch)).toBe(false)
    expect(OUTDOORS).toContain('ground')
    expect(createStage({ slug: 'g', palette: {}, spawn: { x: 0, y: 0 } }).tickOf(SKY_MS / 2)).toBeLessThanOrEqual(SKY_MS / 2)
  } finally { hold('weather', null) }
})

test('a pin replaces the clock, a typo does not', () => {
  const ms = 3 * WEATHER_MS
  for (const k of ['clear', 'rain', 'snow', 'storm']) pinned(k, () => expect(almanacAt(ms).weather).toBe(k))
  pinned('hail', () => expect(almanacAt(ms).weather).toBe(pinned(null, () => almanacAt(ms).weather)))
  pinned('rain', () => expect(untilWeatherChange(ms)).toBe(Infinity))
  pinned(null, () => expect(untilWeatherChange(ms + 1000)).toBe(WEATHER_MS - 1000))
})

test('a screen holds one field of the almanac, and the rest stays the clock\'s', () => {
  const ms = MIDNIGHT + 3 * WEATHER_MS
  const clock = pinned(null, () => almanacAt(ms))
  // The season is `stage.mjs`'s pin, imported above; the weather is the clock's.
  const fell = scheduleAt(ms) === 'rain' && tempAt(ms) <= 0 ? 'snow' : scheduleAt(ms)
  expect(clock).toEqual({ darkness: darkness(ms), season: 'summer', weather: fell, wind: windAt(ms), moon: moonAt(ms), temp: tempAt(ms), ground: pinned(null, () => groundAt(ms)) })
  expect(seasonAt(ms)).toBe('winter')                                     // the clock's, in January 1970
  const pin = process.env.HAVEN_SEASON
  try {
    process.env.HAVEN_SEASON = 'monsoon'
    expect(almanacAt(ms).season).toBe('winter')                           // a pin that is no season is the clock's
  } finally { process.env.HAVEN_SEASON = pin }
  // the ground is what the weather left, so it follows a held weather too
  pinned('rain', () => expect(almanacAt(ms, { weather: 'snow' })).toEqual({ ...clock, weather: 'snow', ground: { wet: 0, snow: 1 } }))
  pinned(null, () => expect(almanacAt(ms, { season: 'winter' })).toEqual({ ...clock, season: 'winter' }))
  expect(heldOf('season', { season: 'winter' })).toBe('winter')
  pinned(null, () => expect(almanacAt(ms)).toEqual(clock))
  // the server holds nothing, so a screen's store never reaches its almanac
  try {
    hold('weather', 'snow')
    pinned(null, () => expect(almanacAt(ms)).toEqual(clock))
    expect(() => hold('season', 'monsoon')).toThrow(/no season is called monsoon/)
    expect(() => hold('darkness', 1)).toThrow(/the almanac holds no darkness/)
  } finally { hold('weather', null) }
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

test('the wind is one per spell, the clock\'s, and a storm\'s is the strongest', () => {
  const winds = [...Array(600).keys()].map((i) => i * WEATHER_MS).map((ms) => {
    expect(windAt(ms + WEATHER_MS - 1)).toEqual(windAt(ms))
    return { kind: scheduleAt(ms), ...windAt(ms) }
  })
  for (const w of winds) expect(w.strength).toBeGreaterThanOrEqual(w.kind === 'storm' ? 2 : 0)
  for (const w of winds) expect(w.strength).toBeLessThanOrEqual(w.kind === 'storm' ? 3 : 2)
  expect(new Set(winds.map((w) => w.dx))).toEqual(new Set([1, -1]))
  expect(new Set(winds.filter((w) => w.kind !== 'storm').map((w) => w.strength))).toEqual(new Set([0, 1, 2]))
  // A held storm keeps the clock's wind: a hold replaces one field.
  const calm = winds.findIndex((w) => w.kind !== 'storm' && w.strength === 0) * WEATHER_MS
  expect(almanacAt(calm, { weather: 'storm' }).wind).toEqual(windAt(calm))
})

test('every fall drifts a column downwind every GUST steps, and calm falls straight', () => {
  for (const kind of ['rain', 'snow', 'storm']) {
    const { ms } = FALL[kind]
    for (const y of column(kind, 20, 100 * ms)) expect(fallAt(kind, 20, y + 1, 101 * ms)).toBeTruthy()   // calm
    for (const strength of [1, 2, 3]) for (const dx of [1, -1]) {
      const per = GUST[strength], wind = { dx, strength }, at = 100 * per * ms
      const now = Array.from({ length: 80 }, (_, y) => y).filter((y) => fallAt(kind, 20, y, at, wind))
      expect(now.length).toBeGreaterThan(0)
      for (const y of now) expect(fallAt(kind, 20 + dx, y + per, at + per * ms, wind)).toBeTruthy()   // a column downwind, GUST rows lower
    }
  }
})

test('rain leans with a wind of GUST 2 or less and snow never does', () => {
  const lean = (kind, wind) => {
    for (let y = 0; y < 80; y++) { const d = fallAt(kind, 7, y, 0, wind); if (d) return d.ch }
  }
  expect(lean('rain', { dx: 1, strength: 1 })).toBe("'")
  expect(lean('rain', { dx: 1, strength: 2 })).toBe('\\')
  expect(lean('storm', { dx: -1, strength: 3 })).toBe('/')
  expect(lean('snow', { dx: 1, strength: 3 })).toBe('*')
})

test('a cloud drifts the way the rain under it does, and stands in a calm', () => {
  const row = (ms, wind) => Array.from({ length: 97 }, (_, x) => cloudAt(x, 1, ms, wind)?.ch ?? ' ').join('')
  for (const dx of [1, -1]) {
    const wind = { dx, strength: 2 }
    const before = row(0, wind), after = row(GUST[2] * CLOUD_MS, wind)
    expect(dx > 0 ? after.slice(1) : after.slice(0, -1)).toBe(dx > 0 ? before.slice(0, -1) : before.slice(1))
  }
  expect(row(60_000, { dx: 1, strength: 0 })).toBe(row(0, { dx: 1, strength: 0 }))
})

test('the density is a handful of cells in a screen, not a curtain', () => {
  const count = (kind) => Array.from({ length: 26 * 97 }, (_, i) => fallAt(kind, i % 97, Math.floor(i / 97), 5 * FALL[kind].ms)).filter(Boolean).length
  expect(count('rain')).toBeGreaterThan(40)
  expect(count('rain')).toBeLessThan(0.15 * 26 * 97)
  expect(count('snow')).toBeGreaterThan(30)
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
    const dropped = cells.filter(([x, y]) => DROPS.has(stage.look(x, y, NOON).ch))
    expect(dropped.length).toBeGreaterThan(40)
    for (const [x, y] of dropped) expect(claimedAt(x, y)).toBe(false)
    expect(stage.look(20, 5, NOON)).toEqual({ ch: '|', fg: '#ffffff', bg: undefined })
    expect(stage.look(22, 5, NOON).ch).toBe('!')
    expect(stage.look(4, 5, NOON).ch).toBe('o')
    expect(cells.some(([x, y]) => DROPS.has(inside.look(x, y, NOON).ch))).toBe(false)
    // the glyph is the clock's wind's, the color the rain's by day and the night's blue by night
    const [dx, dy] = dropped[0]
    expect(stage.look(dx, dy, NOON)).toEqual({ ch: fallAt('rain', dx, dy, NOON, windAt(NOON)).ch, fg: FALL.rain.fg, bg: undefined })
    const night = cells.find(([x, y]) => DROPS.has(stage.look(x, y, MIDNIGHT).ch) && !claimedAt(x, y))
    expect([shade(FALL.rain.fg, 1, MOON), shade(FALL.rain.fg, 0.5, MOON)]).toContain(stage.look(...night, MIDNIGHT).fg)
  })
  pinned('snow', () => expect(cells.filter(([x, y]) => stage.look(x, y, NOON).ch === '*').length).toBeGreaterThan(30))
  pinned('clear', () => expect(cells.every(([x, y]) => !DROPS.has(stage.look(x, y, NOON).ch))).toBe(true))
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
  let drops = 0, puddles = 0
  clear.frame.forEach((row, y) => [...row].forEach((ch, x) => {
    const w = wet.frame[y]?.[x] ?? ' '
    if (moving(x, y)) return
    if (ch === ' ') { if (DROPS.has(w)) drops++; else if (w === GROUND.wet.ch) puddles++; else expect(w).toBe(' ') } else expect(w).toBe(ch)
  }))
  expect(drops).toBeGreaterThan(20)
  expect(puddles).toBeGreaterThan(20)                                       // held rain has always rained
}, 30_000)
