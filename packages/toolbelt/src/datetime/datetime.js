/*
 * datetime.js — an instant, read as the wall clock of a place, and written back.
 *
 * Temporal's WORDS without its classes (`FJS-D268`). An instant is an epoch
 * millisecond, a `Date`, or an ISO string carrying `Z` or an offset; a wall clock
 * is a plain `{year, month, day, hour, minute, second}`; a zone is an IANA name.
 * Every export is a function over those, so a column read out of SQLite needs no
 * wrapping and nothing here has to be migrated when Temporal is everywhere.
 *
 * Two inputs this package normally refuses, and how each arrives instead:
 *
 *   the CLOCK   is handed in. `relative(value, now)` takes it as an argument, and
 *               `createDatetime({ now })` closes over a function the APP supplies,
 *               which is what makes `relativeToNow()` possible without a
 *               `Date.now` call anywhere under `src/` (`FJS-D26`, CI § hygiene).
 *   the ZONE    rules are the HOST's ICU table, and there is no other honest
 *               source short of shipping tzdata. Node and bun disagree where a
 *               country changed its rules recently — `America/Asuncion` for three
 *               years of months — so an answer is pure for one runtime's table,
 *               and the spec avoids zones whose rules moved (`FJS-D268`).
 *
 * The one hard function is `resolveWall`: a wall clock names 0, 1 or 2 instants,
 * and nothing in the platform answers the inverse. It reads the zone's offset a
 * day either side and keeps the projections that round-trip — Temporal's own
 * method, graded against its polyfill in `test/fixtures/datetime-vectors.json`.
 */

import { unitInfo } from '../units/units.js'

const MINUTE = 60_000
const HOUR   = 3_600_000
const DAY    = 86_400_000
const WEEK   = 7 * DAY
const MONTH  = 30.436875 * DAY
const YEAR   = 365.2425 * DAY

// ─── instants ─────────────────────────────────────────────────────────────

// A string with no zone names a different moment in every place it is read, and
// `Date.parse` would silently read it in the HOST's zone — a server in UTC and a
// browser in Denver then disagree about one row by seven hours.
const ISO_INSTANT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/

function toEpoch(value, name = 'value') {
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value
  } else if (Object.prototype.toString.call(value) === '[object Date]') {
    const ms = value.getTime()
    if (Number.isFinite(ms)) return ms
  } else if (typeof value === 'string') {
    const m = ISO_INSTANT.exec(value)
    if (!m) {
      throw new TypeError(
        `datetime: ${name} "${value}" is not an instant — it needs a Z or an offset, ` +
        `as in 2026-07-04T16:05:03Z. A time with no zone is a wall clock: read it with fromWall().`
      )
    }
    // Date.parse accepts three fraction digits and no more on every engine.
    const ms = Date.parse(m[1] + (m[2] ? '.' + (m[2] + '00').slice(0, 3) : '') + m[3])
    if (Number.isFinite(ms)) return ms
  }
  throw new TypeError(`datetime: ${name} ${JSON.stringify(value)} is not an instant — pass epoch milliseconds, a valid Date, or an ISO string with a Z or an offset`)
}

// ─── zones ────────────────────────────────────────────────────────────────

function requireZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone === '') {
    throw new TypeError(
      'datetime: timeZone is required — an IANA name like America/Denver, or UTC. ' +
      'Falling back to the host zone would render one row differently on the server and in the browser.'
    )
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
  } catch {
    throw new RangeError(
      `datetime: unknown time zone "${timeZone}". The list is the host's ICU table ` +
      `(Intl.supportedValuesOf('timeZone')) and differs between runtimes.`
    )
  }
}

const PARTS = {
  timeZone: 'UTC', hourCycle: 'h23', numberingSystem: 'latn',
  year: 'numeric', month: 'numeric', day: 'numeric',
  hour: 'numeric', minute: 'numeric', second: 'numeric',
}

// Whole seconds: Intl answers no finer, and local mean time before 1900 carries
// offsets with seconds in them, so rounding to the minute here would misplace them.
function wallOf(ms, timeZone) {
  const f = {}
  for (const { type, value } of new Intl.DateTimeFormat('en-US', { ...PARTS, timeZone }).formatToParts(ms)) {
    if (type in PARTS) f[type] = Number(value)
  }
  f.hour %= 24
  return f
}

function offsetMsAt(ms, timeZone) {
  const second = Math.floor(ms / 1000) * 1000
  const w = wallOf(second, timeZone)
  return epochOfWall({ ...w, millisecond: 0 }) - second
}

// ─── the civil calendar ───────────────────────────────────────────────────

// Integer arithmetic rather than Date.UTC, which maps years 0-99 onto 1900-1999.
function daysFromCivil(year, month, day) {
  const y   = month <= 2 ? year - 1 : year
  const era = Math.floor(y / 400)
  const yoe = y - era * 400
  const doy = Math.floor((153 * (month > 2 ? month - 3 : month + 9) + 2) / 5) + day - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
}

function civilFromDays(days) {
  const z   = days + 719468
  const era = Math.floor(z / 146097)
  const doe = z - era * 146097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365)
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp  = Math.floor((5 * doy + 2) / 153)
  const month = mp < 10 ? mp + 3 : mp - 9
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day: doy - Math.floor((153 * mp + 2) / 5) + 1 }
}

function epochOfWall(w) {
  return daysFromCivil(w.year, w.month, w.day) * DAY + w.hour * HOUR + w.minute * MINUTE + w.second * 1000 + w.millisecond
}

function daysInMonth(year, month) {
  return daysFromCivil(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, 1) - daysFromCivil(year, month, 1)
}

/** Monday is 1 and Sunday is 7, ISO 8601's numbering. 1970-01-01 was a Thursday. */
function isoWeekday(year, month, day) {
  return ((((daysFromCivil(year, month, day) + 3) % 7) + 7) % 7) + 1
}

// The ISO week belongs to the year its THURSDAY falls in, so up to three days at
// either end of a calendar year sit in the neighbor's week: 2024-12-30 is week 1
// of 2025. `W` paired with `YYYY` is wrong on exactly those days, hence `GGGG`.
function isoWeek(year, month, day) {
  const thursday = daysFromCivil(year, month, day) - isoWeekday(year, month, day) + 4
  const weekYear = civilFromDays(thursday).year
  return { weekYear, week: Math.floor((thursday - daysFromCivil(weekYear, 1, 1)) / 7) + 1 }
}

// ─── reading an instant ───────────────────────────────────────────────────

/**
 * An instant → the wall clock it shows in `timeZone`.
 *
 * `weekday` is ISO (Monday 1 … Sunday 7). `offset` is whole minutes east of UTC,
 * so Denver in summer is -360.
 */
export function partsIn(instant, timeZone) {
  const ms = toEpoch(instant, 'instant')
  requireZone(timeZone)
  const w = wallOf(ms, timeZone)
  const millisecond = ((ms % 1000) + 1000) % 1000
  return {
    year: w.year, month: w.month, day: w.day,
    hour: w.hour, minute: w.minute, second: w.second, millisecond,
    weekday: isoWeekday(w.year, w.month, w.day),
    offset:  Math.round((epochOfWall({ ...w, millisecond }) - ms) / MINUTE),
  }
}

/**
 * The stretches of `[from, to]` over which `timeZone` keeps one UTC offset,
 * earliest first: `[{ from, offset }]`, `from` in epoch milliseconds and
 * `offset` in milliseconds east of UTC, each in force until the next one's
 * `from`. The first starts at `from` itself.
 *
 * For a reader that cannot run this module per row — SQLite in a `GROUP BY`,
 * which has no zone database and to which bun:sqlite can add no function — and
 * so states the zone as a handful of fixed offsets with the instants they
 * change at. One span almost always; two a year in a zone with summer time.
 *
 * The zone is read every twelve hours and each change is found to the
 * millisecond by halving. A zone that changed twice inside twelve hours would
 * be missed; none has.
 */
export function offsetSpans(from, to, timeZone) {
  let lo = toEpoch(from, 'from')
  const end = toEpoch(to, 'to')
  requireZone(timeZone)
  if (end < lo) throw new RangeError('datetime: offsetSpans wants from <= to')
  const STEP = 12 * HOUR
  const spans = [{ from: lo, offset: offsetMsAt(lo, timeZone) }]
  for (let t = lo; t < end; ) {
    const next = Math.min(t + STEP, end)
    const was = spans[spans.length - 1].offset
    if (offsetMsAt(next, timeZone) !== was) {
      let a = t, b = next          // offset(a) === was, offset(b) !== was
      while (b - a > 1) {
        const mid = Math.floor((a + b) / 2)
        if (offsetMsAt(mid, timeZone) === was) a = mid
        else b = mid
      }
      spans.push({ from: b, offset: offsetMsAt(b, timeZone) })
      t = b
    } else {
      t = next
    }
  }
  return spans
}

// ─── writing a wall clock ─────────────────────────────────────────────────

const FIELD_RANGES = [['hour', 0, 23], ['minute', 0, 59], ['second', 0, 59], ['millisecond', 0, 999]]

function readWall(fields) {
  if (!fields || typeof fields !== 'object') throw new TypeError('datetime: a wall clock is an object — { year, month, day, hour, minute, second }')
  const w = { hour: 0, minute: 0, second: 0, millisecond: 0 }
  for (const key of ['year', 'month', 'day', 'hour', 'minute', 'second', 'millisecond']) {
    if (fields[key] === undefined && key in w) continue
    if (!Number.isInteger(fields[key])) throw new TypeError(`datetime: wall clock field ${key} must be an integer, got ${JSON.stringify(fields[key])}`)
    w[key] = fields[key]
  }
  if (w.month < 1 || w.month > 12) throw new RangeError(`datetime: month ${w.month} is out of range 1-12`)
  const last = daysInMonth(w.year, w.month)
  if (w.day < 1 || w.day > last) throw new RangeError(`datetime: day ${w.day} is out of range 1-${last} for ${w.year}-${String(w.month).padStart(2, '0')}`)
  for (const [key, min, max] of FIELD_RANGES) {
    if (w[key] < min || w[key] > max) throw new RangeError(`datetime: ${key} ${w[key]} is out of range ${min}-${max}`)
  }
  return w
}

function candidates(wall, timeZone) {
  const offsets = new Set([offsetMsAt(wall - DAY, timeZone), offsetMsAt(wall, timeZone), offsetMsAt(wall + DAY, timeZone)])
  const hits = []
  for (const offset of offsets) {
    const ms = wall - offset
    if (offsetMsAt(ms, timeZone) === offset && !hits.includes(ms)) hits.push(ms)
  }
  return hits.sort((a, b) => a - b)
}

/**
 * A wall clock in `timeZone` → every instant it names, earliest first.
 *
 * One, almost always. Two when the clock went back and the hour happened twice;
 * none when the clock went forward past it. A caller who has to pick one wants
 * `fromWall`, which says how.
 */
export function resolveWall(fields, timeZone) {
  const w = readWall(fields)
  requireZone(timeZone)
  return candidates(epochOfWall(w), timeZone)
}

const DISAMBIGUATION = ['compatible', 'earlier', 'later', 'reject']

/**
 * A wall clock in `timeZone` → one instant, choosing as Temporal does.
 *
 *   compatible  (default) the earlier of two; past a gap, the later side
 *   earlier     the earlier of two; past a gap, shifted back by the gap
 *   later       the later of two; past a gap, shifted forward by the gap
 *   reject      throws on both, which is what a caller that cares should pass
 */
export function fromWall(fields, timeZone, { disambiguation = 'compatible' } = {}) {
  if (!DISAMBIGUATION.includes(disambiguation)) {
    throw new RangeError(`datetime: disambiguation "${disambiguation}" is not one of ${DISAMBIGUATION.join(', ')}`)
  }
  const w    = readWall(fields)
  requireZone(timeZone)
  const wall = epochOfWall(w)
  const hits = candidates(wall, timeZone)
  const at   = () => `${formatWall(w)} in ${timeZone}`

  if (hits.length === 1) return hits[0]
  if (hits.length === 2) {
    if (disambiguation === 'reject') throw new RangeError(`datetime: ${at()} happens twice — the clock went back. Pass disambiguation 'earlier' or 'later'.`)
    return disambiguation === 'later' ? hits[1] : hits[0]
  }
  if (disambiguation === 'reject') throw new RangeError(`datetime: ${at()} does not exist — the clock went forward past it.`)
  const gap = offsetMsAt(wall + DAY, timeZone) - offsetMsAt(wall - DAY, timeZone)
  if (disambiguation === 'earlier') return candidates(wall - gap, timeZone)[0]
  const shifted = candidates(wall + gap, timeZone)
  return shifted[shifted.length - 1]
}

function formatWall(w) {
  const p = (n, width = 2) => String(n).padStart(width, '0')
  return `${p(w.year, 4)}-${p(w.month)}-${p(w.day)}T${p(w.hour)}:${p(w.minute)}:${p(w.second)}`
}

// ─── plain dates ──────────────────────────────────────────────────────────
//
// A day in no zone: '2026-09-14', which is what a `String @date` column holds. A
// billing period, a due date and a start date are days, and an instant holding one
// names a different day wherever it is read — so the calendar arithmetic happens
// on the date, and a zone is asked for only at the two crossings, `plainDateIn`
// and `startOfDay`.

const PLAIN_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

function readDate(value, name = 'date') {
  const m = typeof value === 'string' ? PLAIN_DATE.exec(value) : null
  if (!m) {
    throw new TypeError(`datetime: ${name} ${JSON.stringify(value)} is not a plain date — pass 'YYYY-MM-DD'. An instant becomes one with plainDateIn(instant, timeZone).`)
  }
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (month < 1 || month > 12) throw new RangeError(`datetime: ${name} ${value} has month ${month}, out of range 1-12`)
  const last = daysInMonth(year, month)
  if (day < 1 || day > last) throw new RangeError(`datetime: ${name} ${value} has day ${day}, out of range 1-${last}`)
  return { year, month, day }
}

const writeDate = ({ year, month, day }) => `${pad(year, 4)}-${pad(month)}-${pad(day)}`

/** An instant → the day it falls on in `timeZone`, as 'YYYY-MM-DD'. */
export function plainDateIn(instant, timeZone) {
  return writeDate(partsIn(instant, timeZone))
}

const DURATION = ['years', 'months', 'weeks', 'days']

/**
 * A plain date moved by a duration, as Temporal's `PlainDate.add` with
 * `overflow: 'constrain'`: years and months first, clamped to the last day of the
 * month they land in, then weeks and days.
 *
 *   addToDate('2026-01-31', { months: 1 })   // '2026-02-28'
 *
 * The clamp does not remember the day it came from, so adding a month twice is
 * not adding two months — '2026-01-31' → '02-28' → '03-28'. A recurring period
 * that must keep its day is computed from its anchor each time.
 */
export function addToDate(date, duration) {
  const d = readDate(date)
  if (!duration || typeof duration !== 'object') throw new TypeError(`datetime: addToDate() needs a duration — { ${DURATION.join(', ')} }`)
  for (const key of Object.keys(duration)) {
    if (!DURATION.includes(key)) throw new RangeError(`datetime: duration field "${key}" is not one of ${DURATION.join(', ')}`)
    if (!Number.isInteger(duration[key])) throw new TypeError(`datetime: duration field ${key} must be an integer, got ${JSON.stringify(duration[key])}`)
  }
  const { years = 0, months = 0, weeks = 0, days = 0 } = duration
  const signs = new Set([years, months, weeks, days].filter(Boolean).map(Math.sign))
  if (signs.size > 1) throw new RangeError(`datetime: a duration mixes signs — ${JSON.stringify(duration)}. Add them in two calls, in the order you mean.`)

  const index = d.year * 12 + (d.month - 1) + years * 12 + months
  const year  = Math.floor(index / 12)
  const month = index - year * 12 + 1
  const day   = Math.min(d.day, daysInMonth(year, month))
  return writeDate(civilFromDays(daysFromCivil(year, month, day) + weeks * 7 + days))
}

/** Whole days from `from` to `to` — negative when `to` is earlier. */
export function daysBetween(from, to) {
  const a = readDate(from, 'from')
  const b = readDate(to, 'to')
  return daysFromCivil(b.year, b.month, b.day) - daysFromCivil(a.year, a.month, a.day)
}

/**
 * The first instant of a plain date in `timeZone`, as epoch milliseconds.
 *
 * Midnight, unless the clock jumps past it — Santiago moves its clocks at
 * midnight, so that day starts at 01:00 — which is Temporal's `startOfDay`. A day
 * is `[startOfDay(d), startOfDay(addToDate(d, { days: 1 })))`, and that window is
 * 23 or 25 hours on a transition day, which is why it is not `start + 24h`.
 */
export function startOfDay(date, timeZone) {
  return fromWall(readDate(date), timeZone, { disambiguation: 'compatible' })
}

// ─── commitments ──────────────────────────────────────────────────────────

/**
 * When a `.lite` `@@commitment` falls due on one row — an instant as ISO text,
 * a day as 'YYYY-MM-DD', or `null` where the anchor or the offset is null or
 * unreadable, which is *not owed yet*.
 *
 * `commitment` is the shape `x-commitments` carries — `{ on, kind, offset }`,
 * where `offset` is `null`, `{ sign, value, unit }` or `{ sign, field, unit }`
 * and `unit` is a duration `@unit` symbol. Here because both ends compute it:
 * litestone answers it beside the SQL that selects due rows, and a screen
 * answers it off the row it is showing with no database at all. Two copies
 * would disagree first about a month added to the 31st, which this clamps
 * (`addToDate`) and SQLite's modifier overflows; litestone's
 * `test/commitment.test.ts` grades its SQL against this.
 *
 *   dueAt({ on: 'createdAt', kind: 'instant', offset: { sign: 1, value: 14, unit: 'd' } }, order)
 */
export function dueAt(commitment, row) {
  const anchor = row?.[commitment.on]
  if (anchor == null) return null
  const off = commitment.offset
  const n   = !off ? 0 : off.field ? row[off.field] : off.value
  if (n == null) return null
  if (commitment.kind === 'instant') {
    let ms
    try { ms = toEpoch(anchor, commitment.on) } catch { return null }
    return new Date(ms + (off ? off.sign * n * unitInfo(off.unit).factor * 1000 : 0)).toISOString()
  }
  const date = String(anchor).slice(0, 10)
  if (!off) return date
  const k = off.sign * n
  return addToDate(date,
      off.unit === 'd'  ? { days: k }
    : off.unit === 'wk' ? { weeks: k }
    : off.unit === 'mo' ? { months: k }
    :                     { years: k })
}

// ─── format ───────────────────────────────────────────────────────────────

const pad = (n, width = 2) => String(n).padStart(width, '0')

function named(c, options, type) {
  const part = new Intl.DateTimeFormat(c.locale, { timeZone: c.timeZone, ...options })
    .formatToParts(c.ms)
    .find((p) => p.type === type)
  return part ? part.value : ''
}

// English suffixes only. Another language's ordinal is not a suffix table, and
// guessing one prints a word a native reader would never write.
function ordinal(c, n, token) {
  if (!/^en(?:-|$)/i.test(c.locale)) {
    throw new RangeError(`datetime: token ${token} spells an English ordinal and the locale is "${c.locale}" — use a numeric token, or bracket your own words`)
  }
  const v = n % 100
  return n + (['th', 'st', 'nd', 'rd'][(v - 20) % 10] || ['th', 'st', 'nd', 'rd'][v] || 'th')
}

const quarter     = (p) => Math.floor((p.month - 1) / 3) + 1
const weekOfMonth = (p) => Math.ceil((p.day + isoWeekday(p.year, p.month, 1) - 1) / 7)
const hour        = (c) => (c.twelveHour ? c.parts.hour % 12 || 12 : c.parts.hour)

// Uppercase is the date and lowercase is the time. Numbers are computed here and
// always Latin digits; only NAMES come from Intl, in the caller's locale.
const TOKENS = {
  YYYY: (c) => pad(c.parts.year, 4),
  YY:   (c) => pad(c.parts.year % 100),
  GGGG: (c) => pad(isoWeek(c.parts.year, c.parts.month, c.parts.day).weekYear, 4),
  QQQQ: (c) => ordinal(c, quarter(c.parts), 'QQQQ') + ' quarter',
  QQQ:  (c) => 'Q' + quarter(c.parts),
  QQ:   (c) => pad(quarter(c.parts)),
  Q:    (c) => String(quarter(c.parts)),
  MMMM: (c) => named(c, { month: 'long' }, 'month'),
  MMM:  (c) => named(c, { month: 'short' }, 'month'),
  MM:   (c) => pad(c.parts.month),
  M:    (c) => String(c.parts.month),
  WWWW: (c) => ordinal(c, weekOfMonth(c.parts), 'WWWW') + ' week',
  WWW:  (c) => 'W' + weekOfMonth(c.parts),
  WW:   (c) => pad(isoWeek(c.parts.year, c.parts.month, c.parts.day).week),
  W:    (c) => String(isoWeek(c.parts.year, c.parts.month, c.parts.day).week),
  DDDD: (c) => named(c, { weekday: 'long' }, 'weekday'),
  DDD:  (c) => named(c, { weekday: 'short' }, 'weekday'),
  DD:   (c) => pad(c.parts.day),
  D:    (c) => String(c.parts.day),
  hh:   (c) => pad(hour(c)),
  h:    (c) => String(hour(c)),
  mm:   (c) => pad(c.parts.minute),
  m:    (c) => String(c.parts.minute),
  ss:   (c) => pad(c.parts.second),
  s:    (c) => String(c.parts.second),
  aaa:  (c) => named(c, { dayPeriod: 'long' }, 'dayPeriod'),
  aa:   (c) => named(c, { hour: 'numeric', hourCycle: 'h12' }, 'dayPeriod'),
  a:    (c) => named(c, { hour: 'numeric', hourCycle: 'h12' }, 'dayPeriod').charAt(0),
  ttt:  (c) => named(c, { timeZoneName: 'long' }, 'timeZoneName'),
  tt:   (c) => named(c, { timeZoneName: 'short' }, 'timeZoneName'),
  t:    (c) => (c.parts.offset < 0 ? '-' : '+') + pad(Math.floor(Math.abs(c.parts.offset) / 60)) + ':' + pad(Math.abs(c.parts.offset) % 60),
}

const TOKEN_NAMES = Object.keys(TOKENS).sort((a, b) => b.length - a.length)
const LETTER      = /[A-Za-z]/

// Every run of letters outside brackets must split entirely into tokens. A run
// that does not is refused by name rather than half-substituted, which is how
// the prototype turned "Today is DDDD" into "Todin the afternoony i3 Saturday".
// A run that DOES split is taken as tokens, so a word made of token letters —
// "at" is `a` then `t` — has to be bracketed, and nothing can detect that.
function compile(pattern) {
  if (typeof pattern !== 'string') throw new TypeError('datetime: format() needs a pattern string, such as \'YYYY-MM-DD\'')
  const out = []
  let text = ''
  const flush = () => {
    if (text) out.push(text)
    text = ''
  }

  for (let i = 0; i < pattern.length;) {
    const ch = pattern[i]
    if (ch === '[') {
      const end = pattern.indexOf(']', i)
      if (end < 0) throw new SyntaxError(`datetime: unclosed [ at position ${i} in pattern "${pattern}"`)
      text += pattern.slice(i + 1, end)
      i = end + 1
    } else if (LETTER.test(ch)) {
      let j = i
      while (j < pattern.length && LETTER.test(pattern[j])) j++
      const run = pattern.slice(i, j)
      const tokens = []
      for (let k = 0; k < run.length;) {
        const name = TOKEN_NAMES.find((t) => run.startsWith(t, k))
        if (!name) {
          // `HH` is every other formatter's 24-hour hour, so it arrives by habit.
          const hint = run[k] === 'H' ? ' — the hour is hh or h (lowercase is the time), 24-hour unless the pattern holds a, aa or aaa' : ''
          throw new SyntaxError(`datetime: "${run}" in pattern "${pattern}" is not made of tokens — bracket literal text, as in [${run}]${hint}`)
        }
        tokens.push(name)
        k += name.length
      }
      flush()
      for (const name of tokens) out.push({ token: name })
      i = j
    } else {
      text += ch
      i++
    }
  }
  flush()
  return out
}

/**
 * An instant → text, by a token pattern.
 *
 *   format(order.createdAt, 'DDDD, MMMM D, YYYY [at] h:mm aa', { timeZone: 'America/Denver' })
 *
 * `h`/`hh` are 12-hour when the pattern holds a day period (`a`, `aa`, `aaa`) and
 * 24-hour when it does not, because a 12-hour clock with no AM or PM beside it
 * names two times. `timeZone` is required; `locale` defaults to en-US and
 * reaches names only.
 */
export function format(instant, pattern, { locale = 'en-US', timeZone } = {}) {
  const ms       = toEpoch(instant, 'instant')
  const compiled = compile(pattern)
  const parts    = partsIn(ms, timeZone)
  const c = { ms, parts, locale, timeZone, twelveHour: compiled.some((p) => p.token && p.token[0] === 'a') }
  let out = ''
  for (const p of compiled) out += typeof p === 'string' ? p : TOKENS[p.token](c)
  return out
}

// ─── relative ─────────────────────────────────────────────────────────────

const LADDER = [['year', YEAR], ['month', MONTH], ['week', WEEK], ['day', DAY], ['hour', HOUR], ['minute', MINUTE]]
const STYLES = ['long', 'short', 'narrow']

/**
 * How far `instant` is from `now`, in the largest whole unit: '3 hours ago',
 * 'in 2 days', and 'now' under a minute.
 *
 * ELAPSED time, floored — a month is an average month, and 30 hours ago is
 * '1 day ago' even when it was two calendar days back. `now` is required: the
 * kit reads no clock. `createDatetime({ now })` is the way to stop passing it.
 */
export function relative(instant, now, { locale = 'en-US', style = 'long' } = {}) {
  const ms = toEpoch(instant, 'instant')
  if (now === undefined) {
    throw new TypeError('datetime: relative() needs now — this kit reads no clock. Pass one, or make an instance with createDatetime({ now }) and call relativeToNow().')
  }
  const reference = toEpoch(now, 'now')
  if (!STYLES.includes(style)) throw new RangeError(`datetime: style "${style}" is not one of ${STYLES.join(', ')}`)

  const diff = ms - reference
  const abs  = Math.abs(diff)
  const rtf  = new Intl.RelativeTimeFormat(locale, { style, numeric: 'always' })
  for (const [unit, size] of LADDER) {
    if (abs >= size) return rtf.format(Math.sign(diff) * Math.floor(abs / size), unit)
  }
  return new Intl.RelativeTimeFormat(locale, { style, numeric: 'auto' }).format(0, 'second')
}

// ─── an instance ──────────────────────────────────────────────────────────

/**
 * The locale, zone and clock an app states once, bound into every function.
 *
 *   // web/src/lib/datetime.js
 *   export const dt = createDatetime({ timeZone: viewerZone, now: Date.now })
 *
 *   dt.relativeToNow(order.createdAt)      // '2 hours ago'
 *
 * The instance holds no state and is frozen. It is a value an app module
 * exports, never a setting this package keeps, because one server renders for
 * viewers in many zones and a module-level setting would give them all one.
 * Each bound function still takes per-call options, which win.
 */
export function createDatetime({ locale = 'en-US', timeZone, now } = {}) {
  requireZone(timeZone)
  if (typeof now !== 'function') {
    throw new TypeError('datetime: createDatetime() needs now, a function answering the current instant — pass now: Date.now. This kit reads no clock of its own.')
  }
  return Object.freeze({
    locale,
    timeZone,
    format:        (instant, pattern, options) => format(instant, pattern, { locale, timeZone, ...options }),
    partsIn:       (instant, zone = timeZone) => partsIn(instant, zone),
    resolveWall:   (fields, zone = timeZone) => resolveWall(fields, zone),
    fromWall:      (fields, options = {}) => fromWall(fields, options.timeZone ?? timeZone, options),
    relative:      (instant, reference, options) => relative(instant, reference, { locale, ...options }),
    relativeToNow: (instant, options) => relative(instant, toEpoch(now(), 'now()'), { locale, ...options }),
    plainDateIn:   (instant, zone = timeZone) => plainDateIn(instant, zone),
    startOfDay:    (date, zone = timeZone) => startOfDay(date, zone),
    today:         (zone = timeZone) => plainDateIn(toEpoch(now(), 'now()'), zone),
  })
}
