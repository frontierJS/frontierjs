/*
 * cron.spec.js
 *
 * Two parsers of one grammar existed and were broken differently, so every row
 * here is an expression one of them got wrong plus the ordinary spelling beside
 * it. The pairing is the point: a parser that refused everything, or that
 * accepted everything as `*`, would satisfy half of these on its own.
 *
 * Recorded, for the rows that are corrections rather than refusals:
 *
 *   0 1-5,8 * * *    caravan hours 1,2,3,4,5   junction hours 1,8      now 1,2,3,4,5,8
 *   0 1-5/2 * * *    caravan hours 1,2,3,4,5   junction every 2nd hr   now 1,3,5
 *   0 9 * * 7        both: never fired                                 now Sunday
 */

import { parseCron, cronMatches, CRON_FIELDS } from '../../src/cron/cron.js'

const hours   = (expr) => [...parseCron(expr).hours]
const refuses = (expr) => {
  try { parseCron(expr) } catch (err) { return err.message }
  return null
}

/* ── The ordinary spellings, which must keep working ───────────────── */

test('cron: a wildcard admits every value the field has', function () {
  const f = parseCron('* * * * *')
  for (const { key, min, max } of CRON_FIELDS) {
    assert.equal(f[key].size, max - min + 1)
    assert.ok(f[key].has(min) && f[key].has(max))
  }
})

test('cron: an exact value, a list, a range and a step', function () {
  assert.deepEqual(hours('0 9 * * *'),     [9])
  assert.deepEqual(hours('0 1,3,5 * * *'), [1, 3, 5])
  assert.deepEqual(hours('0 1-5 * * *'),   [1, 2, 3, 4, 5])
  assert.deepEqual(hours('0 */6 * * *'),   [0, 6, 12, 18])
})

test('cron: a bare value with a step runs to the top of the field', function () {
  // Vixie reads `a/n` as `a-max/n`, which is what makes `*/n` an ordinary case
  // rather than a special one.
  assert.deepEqual(hours('0 20/2 * * *'), [20, 22])
})

/* ── A compound term is read WHOLE ─────────────────────────────────── */

test('cron: a range and a list in one field keep both', function () {
  assert.deepEqual(hours('0 1-5,8 * * *'), [1, 2, 3, 4, 5, 8])
})

test('cron: a range with a step steps THROUGH the range', function () {
  assert.deepEqual(hours('0 1-5/2 * * *'), [1, 3, 5])
})

test('cron: several terms of different shapes compose', function () {
  assert.deepEqual(hours('0 0,2-4,9-15/3 * * *'), [0, 2, 3, 4, 9, 12, 15])
})

/* ── Sunday is 0 and 7 ─────────────────────────────────────────────── */

test('cron: the three spellings of Sunday are one day', function () {
  const byName  = [...parseCron('0 9 * * sun').day]
  const byZero  = [...parseCron('0 9 * * 0').day]
  const bySeven = [...parseCron('0 9 * * 7').day]
  assert.deepEqual(byName,  [0])
  assert.deepEqual(byZero,  [0])
  assert.deepEqual(bySeven, [0])
})

test('cron: a 7 inside a range is Sunday too, and 17 is still refused', function () {
  assert.deepEqual([...parseCron("0 9 * * 5-7").day].sort(), [0, 5, 6])
  assert.ok(/day of week/.test(refuses('0 9 * * 17')))
})

/* ── What it refuses, and the ordinary value beside each ───────────── */

test('cron: a value outside its field is refused, naming the field and the bound', function () {
  assert.match(refuses('0 25 * * *'),  /hour value is 25, outside 0-23/)
  assert.match(refuses('61 * * * *'),  /minute value is 61, outside 0-59/)
  assert.match(refuses('0 0 32 * *'),  /day of month value is 32, outside 1-31/)
  assert.match(refuses('0 0 0 * *'),   /day of month value is 0, outside 1-31/)
  assert.match(refuses('0 0 * 13 *'),  /month value is 13, outside 1-12/)
  // and the neighbours that are legal
  assert.equal(refuses('0 23 * * *'), null)
  assert.equal(refuses('59 * * * *'), null)
  assert.equal(refuses('0 0 31 * *'), null)
  assert.equal(refuses('0 0 * 12 *'), null)
})

test('cron: a step of zero is refused rather than matching nothing', function () {
  // `current % 0` is NaN, so this used to be a schedule that parsed and could
  // never fire.
  assert.match(refuses('*/0 * * * *'), /step of 0/)
  assert.equal(refuses('*/1 * * * *'), null)
})

test('cron: a malformed term is refused rather than parsed as far as it goes', function () {
  assert.match(refuses('abc * * * *'),   /not a number/)
  assert.match(refuses('-5 * * * *'),    /range start is missing/)
  assert.match(refuses('1- * * * *'),    /range end is missing/)
  assert.match(refuses('1,,3 * * * *'),  /empty term/)
  assert.match(refuses('5-1 * * * *'),   /runs backwards/)
  assert.match(refuses('5-8-9 * * * *'), /more than one range/)
  assert.match(refuses('*/1/2 * * * *'), /more than one step/)
  assert.match(refuses('0 9 * *'),       /expected 5 fields/)
  assert.match(refuses('0 9 * * * *'),   /expected 5 fields/)
})

/* ── A date that can never happen ──────────────────────────────────── */

test('cron: a day of month that no admitted month is long enough for', function () {
  assert.match(refuses('0 9 31 2 *'), /never occurs in month 2/)
  assert.match(refuses('0 9 30 2 *'), /never occurs in month 2/)
  assert.match(refuses('0 0 31 4,6,9,11 *'), /never occurs in month/)
})

test('cron: the 29th of February is legal, because leap years happen', function () {
  assert.equal(refuses('0 9 29 2 *'), null)
})

test('cron: one admitted month being long enough is enough', function () {
  assert.equal(refuses('0 0 31 1,2 *'), null)
})

/* ── Matching ──────────────────────────────────────────────────────── */

test('cron: a clock reading is matched against every field', function () {
  const f  = parseCron('30 9 * * 1-5')
  const at = (minutes, hours, date, month, day) => cronMatches(f, { minutes, hours, date, month, day })
  assert.ok(at(30, 9, 2, 3, 1))
  assert.ok(!at(31, 9, 2, 3, 1))   // minute
  assert.ok(!at(30, 8, 2, 3, 1))   // hour
  assert.ok(!at(30, 9, 2, 3, 0))   // Sunday
})

test('cron: month is 1-12 as a clock reports it, not 0-11', function () {
  const f = parseCron('0 0 1 1 *')
  assert.ok(cronMatches(f,  { minutes: 0, hours: 0, date: 1, month: 1, day: 3 }))
  assert.ok(!cronMatches(f, { minutes: 0, hours: 0, date: 1, month: 0, day: 3 }))
})
