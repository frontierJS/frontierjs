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
// rain, snow or storm is a function of the clock, and a falling cell is a
// function of the clock and the cell, so a storm falls on the same cells
// everywhere. A storm's lightning is too: a window of the clock either has a
// strike or not, and where it lands and what it sets alight is the stage's
// to say from the same window number.
// `HAVEN_WEATHER` pins one kind in place of the clock's, for a test, a drive
// and a person who wants to see it.
//
// The almanac (7.6) is the one record of all of it: `almanacAt(ms)`, which a
// layer asks rather than the clock's functions one by one, so a screen that
// holds the weather or the season (`hold`) changes that field and nothing
// else, everywhere it is read. What the WORLD causes lives here, a function of
// the clock sent nowhere; what a MEMBER causes is a trace in
// `api/src/memory.ts`.

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
export const isNight = (ms) => almanacAt(ms).darkness === 1

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

const SPELLS = ['clear', 'clear', 'clear', 'clear', 'clear', 'clear', 'rain', 'rain', 'snow', 'storm']

/** The weather the clock schedules at `ms`: `'clear'`, `'rain'`, `'snow'` or `'storm'`. */
export const scheduleAt = (ms) => SPELLS[hash(Math.floor(ms / WEATHER_MS), 7, 11) % SPELLS.length]

/** The kinds of weather, in the order `/weather` names them. */
export const KINDS = ['clear', 'rain', 'snow', 'storm']

/** The seasons, in the order `/season` names them; a piece's `seasons` may name only these. */
export const SEASONS = ['spring', 'summer', 'fall', 'winter']

/** The season the clock gives at `ms`. Summer until the calendar (7.7) reads the date. */
export const seasonAt = (ms) => 'summer'

// ─── the almanac ──────────────────────────────────────────────────────────

/** The kind `HAVEN_WEATHER` pins, or null. Vite bakes the name in at its start (`define`), Bun reads it from the environment. */
const pinned = () => {
  const w = import.meta.env.HAVEN_WEATHER
  return KINDS.includes(w) ? w : null
}

// The fields a screen may hold, and the values each may be held at.
const HOLDABLE = { weather: KINDS, season: SEASONS }

// What this screen holds in place of the clock's, by field. Kept across doors,
// since a scene is a fresh mount and the module is not.
const held = { weather: null, season: null }

/** Hold this screen's `field` of the almanac at `value`, or hand it back to the clock with null. */
export function hold(field, value) {
  const values = HOLDABLE[field]
  if (!values) throw new Error(`the almanac holds no ${field}; a screen holds ${Object.keys(HOLDABLE).join(', ')}`)
  if (value !== null && !values.includes(value)) throw new Error(`no ${field} is called ${value}; it is one of ${values.join(', ')}`)
  held[field] = value
}

/** The value held in place of the clock's for `field`, or null. A screen's hold outranks `HAVEN_WEATHER`: a person who typed the word means it. */
export const heldOf = (field) => held[field] ?? (field === 'weather' ? pinned() : null)

/** The world `ms` into the clock: `{ darkness, season, weather }`, each the clock's unless this screen holds it. */
export const almanacAt = (ms) => ({
  darkness: darkness(ms),
  season:   heldOf('season') ?? seasonAt(ms),
  weather:  heldOf('weather') ?? scheduleAt(ms),
})

/** Milliseconds until the weather can change; Infinity when it is held. */
export const untilWeatherChange = (ms) => (heldOf('weather') ? Infinity : WEATHER_MS - (((ms % WEATHER_MS) + WEATHER_MS) % WEATHER_MS))

/** How each kind falls: a step in ms, cells between drops in a column, the glyph and its color, and how often it drifts a column (0 never). */
export const FALL = {
  rain:  { ms: 200, period: 30, ch: "'",  fg: '#6f9bd1', drift: 0 },
  snow:  { ms: 450, period: 44, ch: '*',  fg: '#eef3ff', drift: 5 },
  storm: { ms: 150, period: 24, ch: '\\', fg: '#5b7fa8', drift: 2 },
}

/** The drop on the cell `x, y` `ms` into the clock for this weather, `{ ch, fg }`, or null. A column has one drop a period, each falling a row a step. */
export function fallAt(kind, x, y, ms) {
  const f = FALL[kind]
  if (!f) return null
  const step = Math.floor(ms / f.ms)
  const col  = f.drift ? x - Math.floor(step / f.drift) : x
  return hash(col, 0, 3) % f.period === (((y - step) % f.period) + f.period) % f.period ? { ch: f.ch, fg: f.fg } : null
}

// ─── storm ────────────────────────────────────────────────────────────────

/** The clock is cut into windows of this long; each has a strike or has none. */
export const STRIKE_MS = 5000

/** How long a bolt is on the sky, and the world lit by it. */
export const FLASH_MS = 300

/** A tree struck burns this long, then stands charred this long, then is itself again. */
export const BURN_MS = 15_000
export const CHAR_MS = 30_000

/** The redraw step while a tree burns: a flame never holds one glyph. */
export const FIRE_MS = 150

/** The strike in window `n` of the clock, `{ at, seed }`, or null: two windows in three have one, somewhere inside it. `seed` is the stage's to turn into a column. */
export function strikeAt(n) {
  if (hash(n, 31, 17) % 3 === 2) return null
  return { at: n * STRIKE_MS + (hash(n, 5, 9) % (STRIKE_MS - FLASH_MS)), seed: hash(n, 1, 2) }
}

/** Whether a bolt is on the sky `ms` into the clock, for the weather the clock (or a pin) holds when it struck. */
export function flashAt(ms) {
  const s = strikeAt(Math.floor(ms / STRIKE_MS))
  return !!s && ms >= s.at && ms < s.at + FLASH_MS && almanacAt(s.at).weather === 'storm'
}

/** How dark the sky is `ms` into the clock: the day's, at least a third under a storm's clouds, none while a bolt is on it. */
export function skyDarkness(ms) {
  const { darkness: d, weather } = almanacAt(ms)
  if (weather !== 'storm') return d
  return flashAt(ms) ? 0 : Math.max(d, 1 / 3)
}

// A cloud row: its glyph, color and how many of four blocks hold cloud.
const CLOUDS = [
  { ch: '\u2593', fg: '#374151', keep: 3 },
  { ch: '\u2592', fg: '#4b5563', keep: 3 },
  { ch: '\u2592', fg: '#6b7280', keep: 2 },
  { ch: '\u2591', fg: '#9ca3af', keep: 1 },
]
const CLOUD_FLASH = '#e5e7eb'
const CLOUD_MS = 1500

/** The cloud on the cell `x, y` `ms` into the clock, `{ ch, fg }`, or null: a few rows along the top of a scene, ragged, drifting a column every CLOUD_MS. */
export function cloudAt(x, y, ms) {
  const row = CLOUDS[y - 1]
  if (!row) return null
  const sx = x - Math.floor(ms / CLOUD_MS)
  if (hash(Math.floor(sx / 5), y, 21) % 4 >= row.keep || hash(sx, y, 22) % 6 === 0) return null
  return { ch: row.ch, fg: flashAt(ms) ? CLOUD_FLASH : row.fg }
}
