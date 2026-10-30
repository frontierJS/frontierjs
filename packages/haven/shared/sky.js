// shared/sky.js — the time of day (`IDEAS/haven.md` 7.2), a pure function of the
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
// and a person who wants to see it; `HAVEN_SEASON` the season, which turns a
// tree's art and so would flip a pinned frame with the month.
//
// The moon (7.9) keeps the real date's phase, as the season keeps its month:
// a full moon lightens the night's shade and a new one darkens it, and it
// crosses the top of an outdoor scene through full night.
//
// The temperature (7.10) decides what falls, and the ground keeps what fell:
// puddles drying after rain and a snow cover that thaws by degrees, replayed
// from the spells before `ms`, so the aftermath is the clock's too.
//
// The almanac (7.6) is the one record of all of it: `almanacAt(ms)`, which a
// layer asks rather than the clock's functions one by one, so a screen that
// holds the weather or the season changes that field and nothing else,
// everywhere it is read. The hold is an argument, `held`: the store a screen
// keeps it in is `web/src/lib/sky/held.js`, and the server passes none. What
// the WORLD causes lives here, a function of
// the clock sent nowhere; what a MEMBER causes is a trace in
// `shared/memory.ts`.

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

/** Whether it is full night: what a door that is there only at night asks. Nothing holds the darkness, so no screen's hold changes it. */
export const isNight = (ms) => darkness(ms) === 1

// What each channel keeps at full night under a new moon and under a full
// one: moonlight is blue. A half moon is between them.
const NEW_NIGHT  = [0.2, 0.26, 0.48]
const FULL_NIGHT = [0.4, 0.5, 0.76]

const shades = new Map()
/** `hex` at darkness `level` (0 is itself, 1 is full night) under a moon giving `light` (0 new, 1 full); undefined stays undefined. */
export const shade = (hex, level, light) => {
  if (!hex || !level) return hex
  const k = hex + level + '/' + light
  let s = shades.get(k)
  if (!s) {
    s = '#' + [1, 3, 5].map((i, c) => {
      const keep = NEW_NIGHT[c] + light * (FULL_NIGHT[c] - NEW_NIGHT[c])
      return Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - level * (1 - keep))).toString(16).padStart(2, '0')
    }).join('')
    shades.set(k, s)
  }
  return s
}

// ─── the moon ─────────────────────────────────────────────────────────────

/** One lunar cycle, new moon to new moon, in real time: the moon keeps the real calendar's days, not the hour-long day's. */
export const SYNODIC_MS = 29.530588853 * 86_400_000

// A new moon to count from: 2000-01-06 18:14 UTC. The mean cycle drifts from
// the true one by under a day, which a glyph and a shade cannot show.
const NEW_MOON = Date.UTC(2000, 0, 6, 18, 14)

// The glyph by eighth of the cycle, lit on the right while it waxes as the
// northern sky has it; a new moon is none.
const GLYPHS = [null, ')', 'D', 'O', 'O', 'O', 'C', '(']

/** The moon's ink. It is a light, so the night never shades it. */
export const MOON_FG = '#f4f1de'

/**
 * The moon `ms` into the clock: `phase` (0 new, 0.5 full) on the real date,
 * `light` the lit part in quarters, so a shaded color is cached per step,
 * `ch` its glyph or null at new moon, and `arc` how far across the sky it is
 * (0 risen in the east, 1 setting in the west) or null when the hour is not
 * full night. The arc moves a step every SKY_MS, as the sky does.
 */
export const moonAt = (ms) => {
  const phase = ((((ms - NEW_MOON) / SYNODIC_MS) % 1) + 1) % 1
  const into  = ((ms % DAY_MS) + DAY_MS) % DAY_MS
  const steps = Math.round(DAY_MS * 0.3 / SKY_MS) - 1
  return {
    phase,
    light: Math.round(((1 - Math.cos(2 * Math.PI * phase)) / 2) * 4) / 4,
    ch:    GLYPHS[Math.round(phase * 8) % 8],
    arc:   darkness(ms) === 1 ? Math.min(1, Math.floor((into - DAY_MS * 0.6) / SKY_MS) / steps) : null,
  }
}

/** A cheap integer hash of three numbers — the clock's own dice, shared by whatever must agree across screens. */
export const hash = (a, b, c) => {
  let h = (a * 374761393 + b * 668265263 + c * 2246822519) >>> 0
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0
  return (h ^ (h >>> 16)) >>> 0
}

/** How long one spell of weather lasts: ten minutes. */
export const WEATHER_MS = DAY_MS / 6

// Ten spells a season, drawn from by the clock: storms mostly summer, rain
// mostly spring and fall, and no snow anywhere -- a rain spell cold enough
// falls as snow (7.10), which is how winter gets it.
const SPELLS = {
  spring: ['clear', 'clear', 'clear', 'clear', 'clear', 'rain', 'rain', 'rain', 'rain', 'storm'],
  summer: ['clear', 'clear', 'clear', 'clear', 'clear', 'clear', 'clear', 'rain', 'storm', 'storm'],
  fall:   ['clear', 'clear', 'clear', 'clear', 'clear', 'rain', 'rain', 'rain', 'rain', 'storm'],
  winter: ['clear', 'clear', 'clear', 'clear', 'clear', 'clear', 'rain', 'rain', 'rain', 'rain'],
}

/**
 * The spell the clock schedules at `ms`: `'clear'`, `'rain'` or `'storm'`,
 * weighted by the CLOCK's season. A screen holding winter sees no snow the
 * clock did not send: a hold replaces one field and nothing else. What falls
 * is `tempAt`'s to say.
 */
export const scheduleAt = (ms) => {
  const spells = SPELLS[seasonAt(ms)]
  return spells[hash(Math.floor(ms / WEATHER_MS), 7, 11) % spells.length]
}

// ─── temperature ──────────────────────────────────────────────────────────

// Degrees at dusk under a clear sky, by the clock's season; the day is four
// warmer and the night four colder.
const WARMTH = { spring: 8, summer: 21, fall: 9, winter: -1 }
// What a spell's clouds take off it.
const CHILL = { clear: 0, rain: -2, storm: -4 }

/**
 * Degrees Celsius `ms` into the clock, a whole number: the clock's season,
 * the hour and the spell, swung three either way per spell so that one
 * winter afternoon rains and the next snows. Never stored and not holdable:
 * it is what decides what falls, and the ground's thaw.
 */
export const tempAt = (ms) => {
  const n = Math.floor(ms / WEATHER_MS)
  return Math.round(WARMTH[seasonAt(ms)] + 4 - 8 * darkness(ms) + CHILL[scheduleAt(ms)] + hash(n, 19, 7) % 7 - 3)
}

/** What the clock lets fall at `ms`: its spell, but a rain spell at or below freezing is snow. */
const fallen = (ms) => {
  const spell = scheduleAt(ms)
  return spell === 'rain' && tempAt(ms) <= 0 ? 'snow' : spell
}

// ─── the ground ───────────────────────────────────────────────────────────

/** How long the ground remembers: what fell before this is gone from it. */
export const GROUND_MS = DAY_MS

// Per SKY_MS step: rain wets the ground in two, snow covers it in three, the
// wet dries in four, and a cover thaws by THAW for each degree above freezing.
const WETS = 1 / 2
const COVERS = 1 / 3
const DRIES = 1 / 4
const THAW = 1 / 10

const grounds = new Map()
/**
 * What the weather left on the ground `ms` into the clock under `held`, `{ wet, snow }`,
 * each 0 (bare) to 1: the spells of the last GROUND_MS replayed a SKY_MS step
 * at a time from bare, so it is the clock's and every screen agrees. Rain or
 * a storm wets it and a dry step dries it; snow covers it and nothing thaws
 * while it falls. A screen holding the weather has always had it, so holding
 * `clear` leaves the ground bare.
 */
export const groundAt = (ms, held = NONE) => {
  const step = Math.floor(ms / SKY_MS)
  const weather = heldOf('weather', held)
  const k = step + '/' + weather
  let g = grounds.get(k)
  if (g) return g
  let wet = 0, snow = 0
  for (let s = step - GROUND_MS / SKY_MS + 1; s <= step; s++) {
    const t = s * SKY_MS
    const kind = weather ?? fallen(t)
    wet = Math.max(0, Math.min(1, kind === 'rain' || kind === 'storm' ? wet + WETS : wet - DRIES))
    snow = Math.max(0, Math.min(1, kind === 'snow' ? snow + COVERS : snow - Math.max(0, tempAt(t)) * THAW))
  }
  if (grounds.size > 64) grounds.clear()
  grounds.set(k, g = { wet, snow })
  return g
}

/** How the ground is drawn: a puddle on up to one blank cell in twelve, a cover on up to one in two, fewer as each fades. */
export const GROUND = {
  wet:  { ch: '~', fg: '#3e6489', share: 1 / 12 },
  snow: { ch: '·', fg: '#dfe7f2', share: 1 / 2 },
}

/** What the ground shows on the cell `x, y` under `ground`, `{ ch, fg }`, or null: snow over a puddle. */
export function groundOn(x, y, ground) {
  for (const kind of ['snow', 'wet']) {
    const g = GROUND[kind]
    if (ground[kind] && hash(x, y, kind === 'snow' ? 43 : 41) % 1200 < ground[kind] * g.share * 1200) return { ch: g.ch, fg: g.fg }
  }
  return null
}

/** The kinds of weather, in the order `/weather` names them. */
export const KINDS = ['clear', 'rain', 'snow', 'storm']

/** The seasons, in the order `/season` names them; a piece's `seasons` may name only these. */
export const SEASONS = ['spring', 'summer', 'fall', 'winter']

/**
 * The season at `ms` by the real calendar (7.7): the UTC month, taken
 * meteorologically (Dec–Feb winter) in the northern hemisphere. The day stays
 * an hour; the year is the real one.
 */
export const seasonAt = (ms) => SEASONS[(Math.floor(((new Date(ms).getUTCMonth() + 1) % 12) / 3) + 3) % 4]

// ─── the almanac ──────────────────────────────────────────────────────────

/** The fields a screen may hold, and the values each may be held at. */
export const HOLDABLE = { weather: KINDS, season: SEASONS }

/** No field held: what the server, which holds nothing, reads under. */
const NONE = Object.freeze({})

// What the environment pins each field at. Spelled out rather than built from
// the field's name, because Vite bakes in only a name it sees whole
// (`define`); Bun reads it from the environment.
const PINS = { weather: () => import.meta.env.HAVEN_WEATHER, season: () => import.meta.env.HAVEN_SEASON }

/** The value `HAVEN_WEATHER` or `HAVEN_SEASON` pins `field` at, or null; anything that is not one of its values is the clock's. */
const pinned = (field) => {
  const v = PINS[field]()
  return HOLDABLE[field].includes(v) ? v : null
}

/** The value `held` (`{ weather?, season? }`) or the environment's pin has in place of the clock's for `field`, or null. A screen's hold outranks the pin: a person who typed the word means it. */
export const heldOf = (field, held = NONE) => held[field] ?? pinned(field)

// `look()` asks the almanac once per cell at one `ms`, so the last answer is kept.
/** @type {{ key: string | null, almanac: any }} */
let last = { key: null, almanac: null }

/** The world `ms` into the clock: `{ darkness, season, weather, wind, moon, temp, ground }`, each the clock's unless `held` or a pin says otherwise. */
export const almanacAt = (ms, held = NONE) => {
  const season = heldOf('season', held), weather = heldOf('weather', held)
  const key = ms + '/' + season + '/' + weather
  if (last.key === key) return last.almanac
  const almanac = {
    darkness: darkness(ms),
    moon:     moonAt(ms),
    season:   season ?? seasonAt(ms),
    weather:  weather ?? fallen(ms),
    wind:     windAt(ms),
    temp:     tempAt(ms),
    ground:   groundAt(ms, held),
  }
  last = { key, almanac }
  return almanac
}

// The skies a pacer keeps to (`sky` on a `<Pacer>`), each read off the
// world's almanac -- the clock under the environment's pins, never a screen's
// hold. The server, which holds nothing, asks the same when a bolt crosses the
// cell, so a screen holding snow would otherwise draw a white stag the bolt
// flies through.
const world = (ms) => ({ season: pinned('season') ?? seasonAt(ms), weather: pinned('weather') ?? fallen(ms) })

export const SKIES = {
  summer:           (ms) => world(ms).season === 'summer',
  'twilight-rain':  (ms) => { const d = darkness(ms); return d > 0 && d < 1 && world(ms).weather === 'rain' },
  'full-moon-snow': (ms) => darkness(ms) === 1 && moonAt(ms).light === 1 && world(ms).weather === 'snow',
}

/** Whether the sky called `name` is out `ms` into the clock. A name `SKIES` lacks is refused, since it would hide its animal for good. */
export function skyIs(name, ms) {
  const rule = SKIES[name]
  if (!rule) throw new Error(`no sky is called ${name}; a pacer keeps to ${Object.keys(SKIES).join(', ')}`)
  return rule(ms)
}

// ─── wind ─────────────────────────────────────────────────────────────────

/** Steps of a fall per column of drift, by the wind's strength: 0 is calm and drifts nothing. */
export const GUST = [0, 5, 2, 1]

/** No wind: what a fall or a cloud is drawn in when nobody says. */
export const CALM = { dx: 1, strength: 0 }

/**
 * The wind `ms` into the clock, `{ dx, strength }`: `dx` the way it blows
 * (1 east, -1 west) and `strength` an index into GUST. One per spell, drawn by
 * the CLOCK's weather, so a screen holding a storm keeps the clock's wind: a
 * hold replaces one field and nothing else. A storm blows 2 or 3, anything
 * else 0 to 2.
 */
export const windAt = (ms) => {
  const n = Math.floor(ms / WEATHER_MS)
  const storm = scheduleAt(ms) === 'storm'
  return { dx: hash(n, 13, 5) % 2 ? 1 : -1, strength: storm ? 2 + hash(n, 13, 6) % 2 : hash(n, 13, 6) % 3 }
}

/** Milliseconds until the weather can change; Infinity when `held` or a pin holds it. */
export const untilWeatherChange = (ms, held = NONE) => (heldOf('weather', held) ? Infinity : WEATHER_MS - (((ms % WEATHER_MS) + WEATHER_MS) % WEATHER_MS))

/** How each kind falls: a step in ms, cells between drops in a column, the glyph and its color, and whether the glyph leans in a wind of GUST 2 or less. */
export const FALL = {
  rain:  { ms: 200, period: 30, ch: "'", fg: '#6f9bd1', leans: true },
  snow:  { ms: 450, period: 44, ch: '*', fg: '#eef3ff', leans: false },
  storm: { ms: 150, period: 24, ch: "'", fg: '#5b7fa8', leans: true },
}

/** Every glyph a drop is drawn with, its own and leaning either way. */
export const DROPS = new Set([...Object.values(FALL).map((f) => f.ch), '/', '\\'])

/**
 * The drop on the cell `x, y` `ms` into the clock for this weather and `wind`,
 * `{ ch, fg }`, or null. A column has one drop a period, each falling a row a
 * step and drifting a column downwind every GUST steps.
 */
export function fallAt(kind, x, y, ms, wind = CALM) {
  const f = FALL[kind]
  if (!f) return null
  const step = Math.floor(ms / f.ms)
  const per  = GUST[wind.strength]
  const col  = per ? x - wind.dx * Math.floor(step / per) : x
  if (hash(col, 0, 3) % f.period !== (((y - step) % f.period) + f.period) % f.period) return null
  return { ch: f.leans && per && per <= 2 ? (wind.dx > 0 ? '\\' : '/') : f.ch, fg: f.fg }
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

/** Whether a bolt is on the sky `ms` into the clock, for the weather the clock, a pin or `held` has when it struck. */
export function flashAt(ms, held = NONE) {
  const s = strikeAt(Math.floor(ms / STRIKE_MS))
  return !!s && ms >= s.at && ms < s.at + FLASH_MS && almanacAt(s.at, held).weather === 'storm'
}

/** How dark the sky is `ms` into the clock: the day's, at least a third under a storm's clouds, none while a bolt is on it. */
export function skyDarkness(ms, held = NONE) {
  const { darkness: d, weather } = almanacAt(ms, held)
  if (weather !== 'storm') return d
  return flashAt(ms, held) ? 0 : Math.max(d, 1 / 3)
}

// A cloud row: its glyph, color and how many of four blocks hold cloud.
const CLOUDS = [
  { ch: '\u2593', fg: '#374151', keep: 3 },
  { ch: '\u2592', fg: '#4b5563', keep: 3 },
  { ch: '\u2592', fg: '#6b7280', keep: 2 },
  { ch: '\u2591', fg: '#9ca3af', keep: 1 },
]
const CLOUD_FLASH = '#e5e7eb'
// A cloud drifts a column every GUST of these, so it keeps pace with the rain under it.
export const CLOUD_MS = 750

/** The cloud on the cell `x, y` `ms` into the clock, `{ ch, fg }`, or null: a few rows along the top of a scene, ragged, drifting downwind. */
export function cloudAt(x, y, ms, wind = CALM) {
  const row = CLOUDS[y - 1]
  if (!row) return null
  const per = GUST[wind.strength]
  const sx  = per ? x - wind.dx * Math.floor(ms / (per * CLOUD_MS)) : x
  if (hash(Math.floor(sx / 5), y, 21) % 4 >= row.keep || hash(sx, y, 22) % 6 === 0) return null
  return { ch: row.ch, fg: flashAt(ms) ? CLOUD_FLASH : row.fg }
}
