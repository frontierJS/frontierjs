/*
 * units.spec.js
 *
 * Four copies of this function existed and two of them disagreed about the
 * answer, so the cases below are not a wishlist: each is a value one of those
 * callers actually formats — an uploaded file, a docker image layer, a volume,
 * a disk — plus the inputs that reach a formatter when something upstream has
 * no answer.
 */

import { formatBytes, formatMoney, BYTE_UNITS, minorUnits, isKnownCurrency, knownCurrencies } from '../../src/units/units.js'

/* ── The ladder ────────────────────────────────────────────────────── */

test('units: each step is 1024, labelled the familiar way', function () {
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

test('units: a code is normalised, and an absent one falls to the default', function () {
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
  assert.equal(minorUnits('usd'), 2)      // normalised
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
