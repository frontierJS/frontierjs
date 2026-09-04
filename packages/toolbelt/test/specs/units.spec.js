/*
 * units.spec.js
 *
 * Four copies of this function existed and two of them disagreed about the
 * answer, so the cases below are not a wishlist: each is a value one of those
 * callers actually formats — an uploaded file, a docker image layer, a volume,
 * a disk — plus the inputs that reach a formatter when something upstream has
 * no answer.
 */

import { formatBytes, formatMoney, BYTE_UNITS, minorUnits, isKnownCurrency, knownCurrencies, fromMinor, toMinor, roundMinor, allocate } from '../../src/units/units.js'

/* ── The ladder ────────────────────────────────────────────────────── */

test('units: each step is 1024, labeled the familiar way', function () {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(900), '900 B')
  assert.equal(formatBytes(1024), '1.0 KB')
  assert.equal(formatBytes(1024 ** 2), '1.0 MB')
  assert.equal(formatBytes(1024 ** 3), '1.0 GB')
  assert.equal(formatBytes(1024 ** 4), '1.0 TB')
  assert.equal(formatBytes(1024 ** 5), '1.0 PB')
})

test('units: it stops at the top of the ladder rather than inventing a unit', function () {
  assert.equal(formatBytes(1024 ** 6), '1024 PB')
})

/* ── Adaptive precision ────────────────────────────────────────────── */

test('units: one decimal below ten of a unit, none above', function () {
  assert.equal(formatBytes(5 * 1024 ** 2), '5.0 MB')
  assert.equal(formatBytes(45 * 1024 ** 2), '45 MB')
  assert.equal(formatBytes(500 * 1024 ** 3), '500 GB')
})

test('units: a byte never takes a decimal', function () {
  // There is no half a byte, and `1.0 B` reads as a rounding of something.
  assert.equal(formatBytes(1), '1 B')
  assert.equal(formatBytes(999), '999 B')
})

test('units: decimals overrides it, for a column that must not jitter', function () {
  assert.equal(formatBytes(45 * 1024 ** 2, { decimals: 2 }), '45.00 MB')
  assert.equal(formatBytes(5 * 1024 ** 2, { decimals: 0 }), '5 MB')
})

/* ── What reaches a formatter when nothing upstream has an answer ──── */

test('units: not a number is not zero', function () {
  // '0 B' for a missing size reads as an empty file, which is a fact this
  // function does not have.
  assert.equal(formatBytes(undefined), '')
  assert.equal(formatBytes(null), '')
  assert.equal(formatBytes(NaN), '')
  assert.equal(formatBytes('nope'), '')
  assert.equal(formatBytes(Infinity), '')
})

test('units: a numeric string is a number', function () {
  // JSON over a wire, and SQLite's own answer for a big integer.
  assert.equal(formatBytes('5242880'), '5.0 MB')
})

test('units: a negative is a difference, and keeps its sign', function () {
  assert.equal(formatBytes(-2048), '-2.0 KB')
})

/* ── The ladder is readable ────────────────────────────────────────── */

test('units: BYTE_UNITS is the ladder, and it is frozen', function () {
  assert.equal(BYTE_UNITS.join(','), 'B,KB,MB,GB,TB,PB')
  assert.equal(Object.isFrozen(BYTE_UNITS), true)
})

/* ── Money ─────────────────────────────────────────────────────────── */

test('units: the bare symbol, in one locale, for every currency', function () {
  // `en-US` + narrowSymbol, on purpose. The currency's own home locale would
  // answer `US$28.00` for dollars read from London — correct, and not what a
  // price tag says.
  assert.equal(formatMoney(28, 'USD'), '$28.00')
  assert.equal(formatMoney(28, 'GBP'), '£28.00')
  assert.equal(formatMoney(28, 'EUR'), '€28.00')
})

test('units: USD is the default', function () {
  assert.equal(formatMoney(28), '$28.00')
})

test('units: the currency decides the decimals, not the caller', function () {
  // The reason this is Intl and not a symbol table. JPY has no minor unit, and
  // every hand-rolled `toFixed(2)` invents one.
  assert.equal(formatMoney(1235, 'JPY'), '¥1,235')
})

test('units: thousands are grouped', function () {
  assert.equal(formatMoney(1234.5, 'USD'), '$1,234.50')
})

test('units: a negative keeps its sign', function () {
  assert.equal(formatMoney(-9.5, 'USD'), '-$9.50')
})

test('units: decimals can be fixed for a column that must not jitter', function () {
  assert.equal(formatMoney(28, 'USD', { decimals: 0 }), '$28')
})

test('units: a locale can be stated where the reader is the point', function () {
  // An invoice, a statement. The grouping and the symbol's side both move.
  assert.equal(formatMoney(1234.5, 'EUR', { locale: 'de-DE' }).includes('€'), true)
})

test('units: nothing answered is not free', function () {
  // formatBytes's reason exactly: Number(null) is 0, and a missing price must
  // not render as zero.
  assert.equal(formatMoney(null), '')
  assert.equal(formatMoney(undefined), '')
  assert.equal(formatMoney(''), '')
  assert.equal(formatMoney(NaN), '')
  assert.equal(formatMoney('nope'), '')
})

test('units: zero IS an answer', function () {
  assert.equal(formatMoney(0, 'USD'), '$0.00')
})

test('units: an unrecognised 3-letter code prints the code', function () {
  // Intl accepts any well-formed code and uses it where the symbol goes, which
  // is the honest rendering — it says which currency and admits it has no
  // glyph. The separator is a NO-BREAK SPACE (U+00A0), which is Intl's and not
  // ours: asserting a plain space here fails with two strings that look
  // identical in the diff.
  assert.equal(formatMoney(12, 'XYZ'), 'XYZ\u00A012.00')
})

test('units: a MALFORMED code is the case the catch exists for', function () {
  // Intl raises a RangeError below three letters, and a thrown formatter takes
  // the screen with it. Same shape as the branch above, with an ordinary space.
  assert.equal(formatMoney(12, 'US'), 'US 12.00')
})

test('units: a code is normalized, and an absent one falls to the default', function () {
  assert.equal(formatMoney(12, 'usd'), '$12.00')
  assert.equal(formatMoney(12, ''),    '$12.00')
})

test('units: a numeric string is a number here too', function () {
  assert.equal(formatMoney('28.5', 'USD'), '$28.50')
})

// ─── Minor units ──────────────────────────────────────────────────────────────

test('units: minorUnits reads the currency, not a table we ship', function () {
  assert.equal(minorUnits('USD'), 2)
  assert.equal(minorUnits('JPY'), 0)      // the yen has no minor unit
  assert.equal(minorUnits('KWD'), 3)
  assert.equal(minorUnits('CLP'), 0)
  assert.equal(minorUnits('usd'), 2)      // normalized
})

test('units: an unknown code THROWS rather than answering two', function () {
  // The whole reason `isKnownCurrency` exists. `Intl.NumberFormat` does not
  // throw on `UDS` — it answers two decimal places — so a typo would take a
  // plausible scale and be wrong by a hundred wherever the real currency has
  // none. Answering here is what lets litestone refuse it at parse.
  assert.throws(() => minorUnits('UDS'), /not a currency this runtime knows/)
  assert.throws(() => minorUnits('BTC'), /not a currency this runtime knows/)
  assert.throws(() => minorUnits('US'),  /not an ISO 4217 code/)
  assert.throws(() => minorUnits(''),    /not an ISO 4217 code/)
})

test('units: isKnownCurrency separates a real code from a plausible one', function () {
  assert.equal(isKnownCurrency('USD'), true)
  assert.equal(isKnownCurrency('XXX'), true)    // ISO's own "no currency" code
  assert.equal(isKnownCurrency('UDS'), false)
  assert.equal(isKnownCurrency('BTC'), false)   // real money, not ISO 4217
})

test('units: the runtime knows a few hundred codes, and the odd ones are the point', function () {
  const known = knownCurrencies()
  assert.ok(known.size > 150, `expected a full ISO list, got ${known.size}`)
  // If this ever shrinks to only two-decimal currencies, `@money` has silently
  // stopped deriving anything.
  const odd = [...known].filter(c => minorUnits(c) !== 2)
  assert.ok(odd.length > 10, `expected currencies with non-2 minor units, got ${odd.length}`)
})

test('units: the minor-unit conversion is the currency\'s, not a hundred', function () {
  assert.equal(fromMinor(1299, 'USD'), 12.99)
  assert.equal(fromMinor(1299, 'JPY'), 1299)     // the yen has no minor unit
  assert.equal(fromMinor(1299, 'KWD'), 1.299)    // and the dinar has three
  assert.equal(fromMinor(0, 'USD'), 0)
  assert.equal(fromMinor(null, 'USD'), 0)
  assert.equal(fromMinor('1250', 'USD'), 12.5)   // the wire is text
})

test('units: toMinor ROUNDS, because 8.29 * 100 is not 829', function () {
  // The truncation a caller reaches for first loses a cent here.
  assert.equal(Math.trunc(8.29 * 100), 828)
  assert.equal(toMinor(8.29, 'USD'), 829)
  assert.equal(toMinor(12.99, 'USD'), 1299)
  assert.equal(toMinor(1299, 'JPY'), 1299)
  assert.equal(toMinor(1.2345, 'KWD'), 1235)
  assert.equal(toMinor('', 'USD'), 0)
})

test('units: minor units round-trip through a formatter', function () {
  assert.equal(formatMoney(fromMinor(1299, 'USD'), 'USD'), '$12.99')
  assert.equal(formatMoney(fromMinor(1299, 'JPY'), 'JPY'), '¥1,299')
})

test('units: an unknown code is refused in both directions', function () {
  assert.throws(() => fromMinor(100, 'UDS'), /not a currency this runtime knows/)
  assert.throws(() => toMinor(1, 'UDS'),     /not a currency this runtime knows/)
})

/* ── Rounding (`FJS-D154`) ─────────────────────────────────────────── */

test('units: half away from zero, so a refund mirrors its charge', function () {
  assert.equal(roundMinor(0.5), 1)
  assert.equal(roundMinor(-0.5), -1)
  assert.equal(roundMinor(1.4999), 1)
  assert.equal(roundMinor(-1.5001), -2)
  // The reason this is not `Math.round`: it breaks ties towards +Infinity, so
  // the two lines below would disagree about the same magnitude.
  assert.equal(Math.round(-0.5), -0)
})

test('units: half-even is the option, because tax law asks for it', function () {
  assert.equal(roundMinor(2.5, { mode: 'half-even' }), 2)
  assert.equal(roundMinor(3.5, { mode: 'half-even' }), 4)
  assert.equal(roundMinor(-2.5, { mode: 'half-even' }), -2)
  // Away from a tie it is the same function.
  assert.equal(roundMinor(2.6, { mode: 'half-even' }), 3)
})

test('units: an unknown mode is refused by name, never taken as the default', function () {
  assert.throws(() => roundMinor(1.5, { mode: 'floor' }), /unknown mode/)
})

test('units: NaN throws here, where the formatters answer an empty string', function () {
  // Display can say nothing; arithmetic cannot. A silent 0 in a total is the
  // failure this whole area exists to stop.
  assert.throws(() => roundMinor(undefined), /finite/)
  assert.throws(() => roundMinor('abc'), /finite/)
})

/* ── Allocation (`FJS-D154`) ───────────────────────────────────────── */

test('units: the parts sum to the whole — the one thing allocate promises', function () {
  assert.deepEqual(allocate(1000, [1, 1, 1]), [334, 333, 333])
  assert.equal(allocate(1000, [1, 1, 1]).reduce((a, b) => a + b, 0), 1000)
})

test('units: Fowler’s five cents by 3:7', function () {
  assert.deepEqual(allocate(5, [3, 7]), [2, 3])
})

test('units: the leftover goes to the largest fractional part, ties by position', function () {
  // Exact shares 1.5 and 1.5 — an even tie, so the earlier line takes it.
  assert.deepEqual(allocate(3, [1, 1]), [2, 1])
  // Exact shares 0.5, 1.5, 3.0 — one unit to place, two lines tied on .5 and
  // the third with no fraction at all, so position decides and the earlier of
  // the tied pair takes it.
  assert.deepEqual(allocate(5, [1, 3, 6]), [1, 1, 3])
})

test('units: a refund splits the way its charge did', function () {
  assert.deepEqual(allocate(-1000, [1, 1, 1]), [-334, -333, -333])
  assert.equal(allocate(-1000, [1, 1, 1]).reduce((a, b) => a + b, 0), -1000)
})

test('units: a zero ratio is a line that gets nothing, not an error', function () {
  assert.deepEqual(allocate(100, [1, 0, 0]), [100, 0, 0])
  assert.deepEqual(allocate(101, [0, 1, 1]), [0, 51, 50])
})

test('units: an exact division leaves nothing to distribute', function () {
  assert.deepEqual(allocate(900, [1, 1, 1]), [300, 300, 300])
  assert.deepEqual(allocate(0, [1, 2, 3]), [0, 0, 0])
})

test('units: it sums exactly over a long sweep of awkward splits', function () {
  // The negative control for the whole function. A rounding bug that is right
  // on the cases somebody thought of is still a receipt that does not add up,
  // so this asks the only question that matters over inputs nobody chose:
  // a deterministic walk, no Math.random, so a failure is reproducible.
  let seed = 12345
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648

  for (let run = 0; run < 2000; run++) {
    const lines  = 1 + Math.floor(next() * 8)
    const ratios = Array.from({ length: lines }, () => Math.floor(next() * 100))
    if (ratios.reduce((a, b) => a + b, 0) === 0) continue
    const amount = Math.floor((next() - 0.5) * 2_000_000)

    const parts = allocate(amount, ratios)
    assert.equal(parts.length, lines)
    assert.equal(parts.reduce((a, b) => a + b, 0), amount)
    assert.ok(parts.every(Number.isInteger))
    // Nobody is off by more than one unit from their exact share, which is what
    // separates a correct distribution from a sum that merely balances.
    const total = ratios.reduce((a, b) => a + b, 0)
    parts.forEach((p, i) => {
      const exact = (Math.abs(amount) * ratios[i]) / total
      assert.ok(Math.abs(Math.abs(p) - exact) < 1)
    })
  }
})

test('units: the refusals name what is wrong with the call', function () {
  assert.throws(() => allocate(10.5, [1, 1]), /whole number/)
  assert.throws(() => allocate(Number.MAX_SAFE_INTEGER + 2, [1, 1]), /2\^53/)
  assert.throws(() => allocate(10, []), /non-empty/)
  assert.throws(() => allocate(10, [1, -1]), />= 0/)
  assert.throws(() => allocate(10, [0, 0]), /sum to 0/)
})
