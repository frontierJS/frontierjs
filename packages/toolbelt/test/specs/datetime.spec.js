/*
 * datetime.spec.js
 *
 * Two halves, graded differently. The zone arithmetic is graded against Temporal:
 * `fixtures/datetime-oracle.json` is the polyfill's answer for every wall clock
 * around every transition in twelve zones, and each oracle test carries a
 * NEGATIVE CONTROL — the obvious one-line inverse, run over the same rows, must
 * fail some of them, or the fixture has stopped sampling the edges and grades
 * nothing. The formatter has no oracle, so its rows are the prototype's measured
 * failures, each beside the ordinary spelling that must keep working.
 *
 * Every row names its zone. No assertion here may depend on the host's zone —
 * the prototype's suite passed only in MST.
 *
 * Runs under node and bun, and the zone table is each runtime's own ICU. A row
 * that fails on one runtime only is a zone whose rules changed between the two
 * tables, which is `FJS-D268`'s stated limit rather than a kit bug: move the zone
 * out of the generator's list rather than special-casing it here.
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { partsIn, resolveWall, fromWall, format, relative, createDatetime } from '../../src/datetime/datetime.js'

const here   = dirname(fileURLToPath(import.meta.url))
const ORACLE = JSON.parse(readFileSync(join(here, '..', 'fixtures', 'datetime-oracle.json'), 'utf8'))

const wallFields = (s) => {
  const [date, time] = s.split('T')
  const [year, month, day] = date.split('-').map(Number)
  const [hour, minute]     = time.split(':').map(Number)
  return { year, month, day, hour, minute }
}

const JULY_4 = Date.UTC(2026, 6, 4, 16, 5, 3)   // a Saturday; 10:05:03 in Denver

/* ── The oracle ─────────────────────────────────────────────────────── */

test('datetime: fromWall agrees with Temporal in all four disambiguation modes', function () {
  const wrong = []
  for (const [zone, wall, ...expected] of ORACLE.resolve) {
    ORACLE.modes.forEach((disambiguation, i) => {
      let got
      try { got = fromWall(wallFields(wall), zone, { disambiguation }) } catch { got = null }
      if (got !== expected[i]) wrong.push(`${zone} ${wall} ${disambiguation}: expected ${expected[i]}, got ${got}`)
    })
  }
  assert.equal(wrong.length, 0, wrong.slice(0, 5).join('\n      '))
})

test('datetime: resolveWall answers two instants in an overlap, none in a gap, one otherwise', function () {
  let overlaps = 0
  let gaps     = 0
  for (const [zone, wall, , earlier, later, reject] of ORACLE.resolve) {
    const hits = resolveWall(wallFields(wall), zone)
    if (reject !== null) {
      assert.deepEqual(hits, [reject], `${zone} ${wall}`)
    } else if (hits.length === 2) {
      overlaps++
      assert.deepEqual(hits, [earlier, later], `${zone} ${wall}`)
    } else {
      gaps++
      assert.equal(hits.length, 0, `${zone} ${wall}`)
    }
  }
  assert.ok(overlaps > 50 && gaps > 50, `the fixture must sample both edges; overlaps ${overlaps}, gaps ${gaps}`)
})

test('datetime: the obvious inverse fails the same rows (negative control)', function () {
  let wrong = 0
  for (const [zone, wall, compatible] of ORACLE.resolve) {
    const f  = wallFields(wall)
    const ms = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute)
    if (ms - partsIn(ms, zone).offset * 60_000 !== compatible) wrong++
  }
  assert.ok(wrong > 50, `subtracting the offset at the wall clock must be wrong around transitions; wrong on ${wrong}`)
})

test('datetime: partsIn agrees with Temporal, including the millisecond before each transition', function () {
  const wrong = []
  for (const [zone, ms, ...expected] of ORACLE.parts) {
    const p   = partsIn(ms, zone)
    const got = [p.year, p.month, p.day, p.hour, p.minute, p.second, p.millisecond, p.weekday, p.offset]
    if (JSON.stringify(got) !== JSON.stringify(expected)) wrong.push(`${zone} ${ms}: expected ${expected}, got ${got}`)
  }
  assert.equal(wrong.length, 0, wrong.slice(0, 5).join('\n      '))
})

test('datetime: W and GGGG agree with Temporal at both ends of every year', function () {
  let differs = 0
  for (const [date, week, weekYear] of ORACLE.weeks) {
    const ms = Date.parse(date + 'T12:00:00Z')
    assert.equal(format(ms, 'W GGGG', { timeZone: 'UTC' }), `${week} ${weekYear}`, date)
    if (format(ms, 'YYYY', { timeZone: 'UTC' }) !== String(weekYear)) differs++
  }
  assert.ok(differs > 0, 'the fixture must hold dates whose week year is not their calendar year')
})

/* ── Instants and zones ─────────────────────────────────────────────── */

test('datetime: an instant is epoch ms, a Date, or an ISO string with a zone', function () {
  const iso = '2026-07-04T16:05:03Z'
  assert.equal(partsIn(JULY_4, 'UTC').hour, 16)
  assert.equal(partsIn(Date.parse(iso), 'UTC').hour, 16)
  assert.equal(partsIn('2026-07-04T10:05:03.123456-06:00', 'UTC').millisecond, 123)
  assert.equal(format(iso, 'YYYY-MM-DD hh:mm:ss', { timeZone: 'UTC' }), '2026-07-04 16:05:03')
})

test('datetime: a string with no zone is refused, and told where to go', function () {
  assert.throws(() => partsIn('2026-07-04 16:05:03', 'UTC'), /not an instant.*fromWall/)
  assert.throws(() => partsIn('2026-07-04T16:05:03', 'UTC'), /needs a Z or an offset/)
  assert.throws(() => partsIn(NaN, 'UTC'), /not an instant/)
})

test('datetime: the zone is required and an unknown one is named', function () {
  assert.throws(() => format(JULY_4, 'YYYY'), /timeZone is required/)
  assert.throws(() => partsIn(JULY_4, 'Mars/Olympus'), /unknown time zone "Mars\/Olympus"/)
})

test('datetime: partsIn — weekday is ISO and offset is minutes east', function () {
  const p = partsIn(JULY_4, 'America/Denver')
  assert.deepEqual(p, { year: 2026, month: 7, day: 4, hour: 10, minute: 5, second: 3, millisecond: 0, weekday: 6, offset: -360 })
  assert.equal(partsIn(JULY_4, 'Asia/Kathmandu').offset, 345)
})

test('datetime: fromWall refuses an impossible calendar date rather than rolling it over', function () {
  assert.throws(() => fromWall({ year: 2026, month: 2, day: 29 }, 'UTC'), /day 29 is out of range 1-28/)
  assert.throws(() => fromWall({ year: 2026, month: 13, day: 1 }, 'UTC'), /month 13/)
  assert.throws(() => fromWall({ year: 2026, month: 1, day: 1, hour: 24 }, 'UTC'), /hour 24/)
  assert.equal(fromWall({ year: 2024, month: 2, day: 29 }, 'UTC'), Date.UTC(2024, 1, 29))
})

test('datetime: reject names the gap and the overlap in different words', function () {
  const opts = { disambiguation: 'reject' }
  assert.throws(() => fromWall({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, 'America/New_York', opts), /does not exist/)
  assert.throws(() => fromWall({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, 'America/New_York', opts), /happens twice/)
  assert.throws(() => fromWall({ year: 2026, month: 1, day: 1 }, 'UTC', { disambiguation: 'nearest' }), /not one of compatible, earlier, later, reject/)
})

/* ── format: the prototype's failures, each beside the ordinary spelling ── */

const denver = (pattern, options) => format(JULY_4, pattern, { timeZone: 'America/Denver', ...options })

test('format: the ordinary patterns', function () {
  assert.equal(denver('YYYY-MM-DD'), '2026-07-04')
  assert.equal(denver('MM/DD/YY'), '07/04/26')
  assert.equal(denver('DDDD, MMMM D, YYYY'), 'Saturday, July 4, 2026')
  assert.equal(denver('DDD MMM D'), 'Sat Jul 4')
  assert.equal(denver('DDDD [the] D[th]'), 'Saturday the 4th')
})

test('format: hh is 24-hour unless the pattern names a day period', function () {
  assert.equal(format(JULY_4, 'hh:mm:ss', { timeZone: 'UTC' }), '16:05:03', 'the prototype answered 04:05:03')
  assert.equal(format(JULY_4, 'h:mm aa', { timeZone: 'UTC' }), '4:05 PM')
  assert.equal(format(JULY_4, 'hh:mm a', { timeZone: 'UTC' }), '04:05 P')
  assert.equal(format(Date.UTC(2026, 0, 1), 'h:mm aa', { timeZone: 'UTC' }), '12:00 AM')
  assert.equal(format(Date.UTC(2026, 0, 1), 'hh:mm', { timeZone: 'UTC' }), '00:00')
})

test('format: minutes and seconds pad without an hour beside them', function () {
  assert.equal(format(Date.UTC(2026, 0, 1, 9, 5, 1), 'mm:ss', { timeZone: 'UTC' }), '05:01', 'the prototype answered 5:1')
  assert.equal(format(Date.UTC(2026, 0, 1, 9, 5, 1), 'm s', { timeZone: 'UTC' }), '5 1')
})

test('format: two tokens of one unit keep their own styles', function () {
  assert.equal(denver('MM (MMMM)'), '07 (July)', 'the prototype gave every token of a unit the LAST one\'s style')
  assert.equal(denver('WWW W [of] YYYY'), 'W1 27 of 2026')
  assert.equal(denver('t tt ttt'), '-06:00 MDT Mountain Daylight Time')
})

test('format: text that is not made of tokens is refused, not substituted', function () {
  assert.throws(() => denver('Today is DDDD'), /"Today" in pattern "Today is DDDD" is not made of tokens — bracket literal text, as in \[Today\]/)
  assert.equal(denver('[Today is] DDDD'), 'Today is Saturday')
  assert.equal(denver('hhmm'), '1005', 'a run of tokens with no separator still splits')
  assert.throws(() => denver('[YYYY'), /unclosed \[ at position 0/)
})

test('format: a word made of token letters is taken as tokens — the stated limit', function () {
  assert.equal(denver('h:mm aa at'), '10:05 AM A-06:00')
  assert.equal(denver('h:mm aa [at]'), '10:05 AM at')
})

test('format: the week year is its own token', function () {
  const dec30 = Date.UTC(2024, 11, 30, 12)
  assert.equal(format(dec30, '[Week] W, GGGG', { timeZone: 'UTC' }), 'Week 1, 2025')
  assert.equal(format(dec30, 'YYYY-MM-DD', { timeZone: 'UTC' }), '2024-12-30')
})

test('format: quarters and week-of-month', function () {
  assert.equal(denver('Q QQ QQQ QQQQ'), '3 03 Q3 3rd quarter')
  assert.equal(format(Date.UTC(2026, 6, 13, 12), 'WWW WWWW', { timeZone: 'UTC' }), 'W3 3rd week')
})

test('format: names follow the locale and numbers stay Latin', function () {
  assert.equal(denver('DDDD, D [de] MMMM', { locale: 'es' }), 'sábado, 4 de julio', 'the prototype ignored the locale')
  assert.equal(denver('YYYY-MM-DD', { locale: 'ar-EG' }), '2026-07-04')
  assert.throws(() => denver('QQQQ', { locale: 'es' }), /QQQQ spells an English ordinal and the locale is "es"/)
  assert.equal(denver('QQQQ', { locale: 'en-GB' }), '3rd quarter')
})

test('format: the caller\'s options object is not written to', function () {
  const options = { timeZone: 'UTC' }
  format(JULY_4, 'YYYY MMMM aa', options)
  assert.deepEqual(options, { timeZone: 'UTC' })
})

/* ── relative ───────────────────────────────────────────────────────── */

const NOW = Date.UTC(2026, 6, 4, 12)
const ago = (ms, options) => relative(NOW - ms, NOW, options)
const M = 60_000, H = 60 * M, D = 24 * H

test('relative: the largest whole unit, floored', function () {
  assert.equal(ago(3 * H + 59 * M), '3 hours ago')
  assert.equal(ago(30 * H), '1 day ago', 'elapsed, not calendar')
  assert.equal(ago(30 * D), '4 weeks ago')
  assert.equal(ago(31 * D), '1 month ago')
  assert.equal(ago(365 * D), '11 months ago')
  assert.equal(ago(366 * D), '1 year ago')
  assert.equal(relative(NOW + 2 * H, NOW), 'in 2 hours')
})

test('relative: under a minute is now, never an empty string', function () {
  assert.equal(ago(0), 'now', 'the prototype answered an empty string')
  assert.equal(ago(59_999), 'now')
  assert.equal(ago(60_000), '1 minute ago')
})

test('relative: narrow is what basecamp wrote by hand', function () {
  assert.equal(ago(5 * M, { style: 'narrow' }), '5m ago')
  assert.equal(ago(2 * H, { style: 'narrow' }), '2h ago')
  assert.equal(ago(3 * D, { style: 'narrow' }), '3d ago')
})

test('relative: now is required and a bad style is named', function () {
  assert.throws(() => relative(NOW), /needs now.*createDatetime/)
  assert.throws(() => ago(H, { style: 'tiny' }), /style "tiny"/)
})

/* ── createDatetime ─────────────────────────────────────────────────── */

test('createDatetime: relativeToNow reads the clock it was handed', function () {
  let clock = NOW
  const dt = createDatetime({ timeZone: 'America/Denver', now: () => clock })
  assert.equal(dt.relativeToNow(NOW - 2 * H), '2 hours ago')
  clock += H
  assert.equal(dt.relativeToNow(NOW - 2 * H), '3 hours ago')
})

test('createDatetime: binds locale and zone, and a per-call option wins', function () {
  const dt = createDatetime({ locale: 'es', timeZone: 'America/Denver', now: () => NOW })
  assert.equal(dt.format(JULY_4, 'DDDD hh:mm'), 'sábado 10:05')
  assert.equal(dt.format(JULY_4, 'hh:mm', { timeZone: 'UTC' }), '16:05')
  assert.equal(dt.partsIn(JULY_4).offset, -360)
  assert.equal(dt.fromWall({ year: 2026, month: 7, day: 4, hour: 10, minute: 5, second: 3 }), JULY_4)
  assert.equal(dt.relative(NOW - 2 * H, NOW), 'hace 2 horas')
})

test('createDatetime: two instances share nothing', function () {
  const a = createDatetime({ timeZone: 'UTC', now: () => NOW })
  const b = createDatetime({ timeZone: 'Asia/Kolkata', now: () => NOW })
  assert.equal(a.format(JULY_4, 'hh:mm'), '16:05')
  assert.equal(b.format(JULY_4, 'hh:mm'), '21:35')
  assert.equal(a.format(JULY_4, 'hh:mm'), '16:05')
  assert.ok(Object.isFrozen(a))
})

test('createDatetime: the zone and the clock are required up front', function () {
  assert.throws(() => createDatetime({ now: () => NOW }), /timeZone is required/)
  assert.throws(() => createDatetime({ timeZone: 'UTC' }), /needs now/)
  assert.throws(() => createDatetime({ timeZone: 'UTC', now: () => 'yesterday' }).relativeToNow(NOW), /now\(\) "yesterday" is not an instant/)
})
