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

// ─── Day of month OR day of week ──────────────────────────────────────────
//
// Cron's one asymmetry, and it reads as a bug: under a uniform five-field AND
// `0 0 1 * mon` fired only when the 1st happened to BE a Monday, which is a
// schedule that runs and looks alive. Every row here is paired with the shape
// that must still AND, because an OR applied unconditionally matches far too
// much and would pass any test that only asks about the two dates.

test('cron: date and weekday are OR\'d when BOTH are restricted', function () {
  const f = parseCron('0 0 1 * mon')
  const at = (date, day) => cronMatches(f, { minutes: 0, hours: 0, date, month: 9, day })

  assert.ok(at(1, 2))    // the 1st, a Tuesday — the date carries it
  assert.ok(at(7, 1))    // a Monday, the 7th — the weekday carries it
  assert.ok(at(1, 1))    // both
  assert.ok(!at(2, 3))   // neither, so the OR is not simply true
  assert.ok(!cronMatches(f, { minutes: 1, hours: 0, date: 1, month: 9, day: 2 }))  // minute still ANDs
})

test('cron: with only ONE of the two restricted, the answer is the AND', function () {
  // The other field admits everything, so OR and AND agree — which is what
  // makes the rule cost nothing to state. A matcher that OR'd unconditionally
  // fails here and nowhere above.
  const dateOnly = parseCron('0 0 1 * *')
  assert.ok(cronMatches(dateOnly,  { minutes: 0, hours: 0, date: 1, month: 9, day: 2 }))
  assert.ok(!cronMatches(dateOnly, { minutes: 0, hours: 0, date: 2, month: 9, day: 2 }))

  const dayOnly = parseCron('0 0 * * mon')
  assert.ok(cronMatches(dayOnly,  { minutes: 0, hours: 0, date: 7, month: 9, day: 1 }))
  assert.ok(!cronMatches(dayOnly, { minutes: 0, hours: 0, date: 7, month: 9, day: 2 }))
})

test('cron: restricted is read off the TEXT — the star, as cron reads it', function () {
  // `0-6` names every day and is still not a star, so `0 0 1 * 0-6` ORs and
  // fires daily. A rule that read set COMPLETENESS instead looks tidier and
  // diverges here alone, with nothing said — the one shape the familiarity
  // adjudication rules out. `*/2` is a star because its first character is.
  const spelled = parseCron('0 0 1 * 0-6')
  assert.ok(cronMatches(spelled, { minutes: 0, hours: 0, date: 4, month: 9, day: 4 }))

  const starred = parseCron('0 0 1 * *')
  assert.ok(!cronMatches(starred, { minutes: 0, hours: 0, date: 4, month: 9, day: 4 }))

  assert.deepEqual([...parseCron('0 0 1 * 0-6').day], [...parseCron('0 0 1 * *').day])
  assert.ok(parseCron('0 0 * */2 *').stars.has('month'))
  assert.ok(!parseCron('0 0 * 1-12 *').stars.has('month'))
})

test('cron: an impossible date is still refused, unless a weekday can carry it', function () {
  assert.ok(/never occurs/.test(refuses('0 9 31 2 *')))
  // Under the OR the same expression with a weekday fires on the Mondays in
  // February, so refusing it would refuse a schedule that works.
  const f = parseCron('0 9 31 2 mon')
  assert.ok(cronMatches(f, { minutes: 0, hours: 9, date: 3, month: 2, day: 1 }))
})

// ─── Names belong to a field, not to the line ─────────────────────────────

test('cron: a name is resolved in its OWN field\'s table', function () {
  assert.deepEqual([...parseCron('0 0 * * sat').day], [6])
  // The same word one field to the left was June: six of the seven day names
  // sit inside 1-12, so a misplaced name landed as a number and said nothing.
  assert.ok(/not a number or a month name/.test(refuses('0 0 * sat *')))
  assert.ok(/not a number: "mon"/.test(refuses('mon 0 * * *')))
})

test('cron: month names, which every crontab admits and this refused', function () {
  assert.deepEqual([...parseCron('0 0 * jan *').month], [1])
  assert.deepEqual([...parseCron('0 0 * JAN *').month], [1])
  assert.deepEqual([...parseCron('0 0 * mar-may *').month], [3, 4, 5])
  assert.deepEqual([...parseCron('0 0 * december *').month], [12])
})

test('cron: an ambiguous prefix is named rather than guessed', function () {
  assert.ok(/could be june or july/.test(refuses('0 0 * ju *')))
  assert.ok(/could be march or may/.test(refuses('0 0 * ma *')))
  assert.deepEqual([...parseCron('0 0 * jun *').month], [6])   // one more letter resolves it
  assert.deepEqual([...parseCron('0 0 * * mo').day], [1])      // two IS unambiguous for a day
})

test('cron: a name is not a step', function () {
  assert.ok(/step is not a number: "mon"/.test(refuses('0 0 * * */mon')))
  assert.deepEqual([...parseCron('0 0 * * */2').day], [0, 2, 4, 6])
})

// ─── The parts a matcher is handed ────────────────────────────────────────

test('cron: an incomplete parts object is REFUSED, not answered false', function () {
  const f = parseCron('* * * * *')
  const whole = { minutes: 0, hours: 0, date: 1, month: 1, day: 0 }
  assert.ok(cronMatches(f, whole))

  // `minute` for `minutes` matched nothing, for ever — a schedule registered,
  // listed in `jobs.snapshot.md`, and silent. Each of the five is asked, so a
  // guard that only checked the first would pass on one row alone.
  for (const key of CRON_FIELDS.map((d) => d.key)) {
    const missing = { ...whole }
    delete missing[key]
    let message = ''
    try { cronMatches(f, missing) } catch (err) { message = err.message }
    assert.ok(message.includes(`parts.${key}`), `a missing ${key} must be named, got: ${message}`)
  }
  for (const bad of [null, undefined, {}, { minutes: '0', hours: 0, date: 1, month: 1, day: 0 }]) {
    assert.throws(() => cronMatches(f, bad))
  }

  // A `fields` that did not come from `parseCron` is named too, rather than
  // throwing about a property nobody typed. Sets do not survive JSON, so
  // anything round-tripped is already not one.
  const plain = { minutes: f.minutes, hours: f.hours, date: f.date, month: f.month, day: f.day }
  let said = ''
  try { cronMatches(plain, whole) } catch (err) { said = err.message }
  assert.ok(/must come from parseCron/.test(said), said)
  assert.ok(cronMatches({ ...plain, stars: f.stars }, whole))
})
