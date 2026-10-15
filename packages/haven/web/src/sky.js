// src/sky.js — the time of day (`IDEAS/haven.md` 7.2), a pure function of the
// wall clock. Nothing is sent and nothing is stored: two terminals and a tab
// read `Date.now()` and so draw the same sky, and a test hands `ms` in.
//
// A day is DAY_MS. The first half is daylight, dusk takes a tenth, night three
// tenths, dawn the last tenth. Darkness is a level in thirds rather than a
// continuous value: a shaded color is cached per level, and a terminal that
// redraws on a coarse timer would otherwise step through colors nobody else
// draws.
//
// Weather (`IDEAS/haven.md` 7.3) is the same kind of thing: a spell of clear,
// rain or snow is a function of the clock, and a falling cell is a function of
// the clock and the cell, so a storm falls on the same cells everywhere.
// `HAVEN_WEATHER` pins one kind in place of the clock's, for a test, a drive
// and a person who wants to see it.

/** One day of real time. An hour, to start. */
export const DAY_MS = 3_600_000

/** The shortest time in which the sky can change a level: where a stage with nothing else moving still redraws. */
export const SKY_MS = DAY_MS / 10 / 3

const RAMP = 3

/** How dark it is `ms` into the clock: 0, 1/3, 2/3 or 1. */
export function darkness(ms) {
  const t = (((ms % DAY_MS) + DAY_MS) % DAY_MS) / DAY_MS
  if (t < 0.5) return 0
  if (t < 0.6) return Math.round(((t - 0.5) / 0.1) * RAMP) / RAMP
  if (t < 0.9) return 1
  return Math.round(((1 - t) / 0.1) * RAMP) / RAMP
}

/** Whether it is full night: what a door that is there only at night asks. */
export const isNight = (ms) => darkness(ms) === 1

/** What each channel keeps at full night: moonlight is blue. */
const NIGHT = [0.3, 0.38, 0.62]

const shades = new Map()
/** `hex` at darkness `level` (0 is itself, 1 is full night); undefined stays undefined. */
export const shade = (hex, level) => {
  if (!hex || !level) return hex
  const k = hex + level
  let s = shades.get(k)
  if (!s) {
    s = '#' + [1, 3, 5].map((i, c) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - level * (1 - NIGHT[c]))).toString(16).padStart(2, '0')).join('')
    shades.set(k, s)
  }
  return s
}

/** A cheap integer hash of three numbers — the clock's own dice, shared by whatever must agree across screens. */
export const hash = (a, b, c) => {
  let h = (a * 374761393 + b * 668265263 + c * 2246822519) >>> 0
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0
  return (h ^ (h >>> 16)) >>> 0
}

/** How long one spell of weather lasts: ten minutes. */
export const WEATHER_MS = DAY_MS / 6

const SPELLS = ['clear', 'clear', 'clear', 'clear', 'clear', 'rain', 'rain', 'rain', 'snow', 'snow']

/** The weather the clock schedules at `ms`: `'clear'`, `'rain'` or `'snow'`. */
export const scheduleAt = (ms) => SPELLS[hash(Math.floor(ms / WEATHER_MS), 7, 11) % SPELLS.length]

/** The kind `HAVEN_WEATHER` pins, or null. Vite bakes the name in at its start (`define`), Bun reads it from the environment. */
const pinned = () => {
  const w = import.meta.env.HAVEN_WEATHER
  return w === 'clear' || w === 'rain' || w === 'snow' ? w : null
}

/** The weather at `ms`: the pinned kind, else the clock's. */
export const weatherAt = (ms) => pinned() ?? scheduleAt(ms)

/** Milliseconds until the weather can change; Infinity when it is pinned. */
export const untilWeatherChange = (ms) => (pinned() ? Infinity : WEATHER_MS - (((ms % WEATHER_MS) + WEATHER_MS) % WEATHER_MS))

/** How each kind falls: a step in ms, cells between drops in a column, the glyph and its color, and how often it drifts a column (0 never). */
export const FALL = {
  rain: { ms: 200, period: 13, ch: "'", fg: '#6f9bd1', drift: 0 },
  snow: { ms: 450, period: 19, ch: '*', fg: '#eef3ff', drift: 5 },
}

/** The drop on the cell `x, y` `ms` into the clock for this weather, `{ ch, fg }`, or null. A column has one drop a period, each falling a row a step. */
export function fallAt(kind, x, y, ms) {
  const f = FALL[kind]
  if (!f) return null
  const step = Math.floor(ms / f.ms)
  const col  = f.drift ? x - Math.floor(step / f.drift) : x
  return hash(col, 0, 3) % f.period === (((y - step) % f.period) + f.period) % f.period ? { ch: f.ch, fg: f.fg } : null
}
