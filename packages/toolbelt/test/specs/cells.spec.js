/*
 * cells.spec.js
 *
 * `parseCell` — text from a file somebody else wrote, read as a column's type.
 * Every refusal sits beside an acceptance one character away, because a reader
 * that refused everything would pass every refusal on its own. The dirty rows
 * are the kinds the transit stressor's `orders-dirty.csv` carries.
 */

import { parseCell } from '../../src/cells/cells.js'

const value  = (r) => { assert.equal(r.reason, undefined, `expected a value, got the reason '${r.reason}'`); return r.value }
const reason = (r) => { assert.equal('value' in r, false, `expected a reason, got the value ${JSON.stringify(r.value)}`); return r.reason }

test('cells: a whole number, and the three things a whole number is not', function () {
  assert.equal(value(parseCell('42', 'int')), 42)
  assert.equal(value(parseCell('-7', 'int')), -7)
  assert.equal(reason(parseCell('3.5', 'int')), 'not a whole number')
  assert.equal(reason(parseCell('two', 'int')), 'not a whole number')
  assert.equal(reason(parseCell('-', 'int')), 'not a whole number')
  assert.equal(reason(parseCell('9007199254740993', 'int')), 'a whole number too large to hold exactly')
})

test('cells: a thousands separator is refused and said so, never read', function () {
  // In de-DE `1.234` is one thousand two hundred and thirty-four; in en-US it
  // is one and a bit. Reading either is a guess that lands a wrong amount.
  assert.equal(value(parseCell('1234.50', 'float')), 1234.5)
  assert.equal(reason(parseCell('1,234.50', 'float')), 'a number, without a thousands separator')
  assert.equal(reason(parseCell('1,234.50', 'scaled', { scale: 2 })), 'a number with at most 2 decimal places, without a thousands separator')
  assert.equal(reason(parseCell('12,345', 'int')), 'a whole number, without a thousands separator')
})

test('cells: a scaled number is read exactly, by its digits', function () {
  // 8.29 * 100 is 828.9999999999999 in binary floating point.
  assert.equal(value(parseCell('8.29', 'scaled', { scale: 2 })), 829)
  assert.equal(value(parseCell('1050.2', 'scaled', { scale: 2 })), 105020)
  assert.equal(value(parseCell('-0.05', 'scaled', { scale: 2 })), -5)
  assert.equal(value(parseCell('-0', 'scaled', { scale: 2 })), 0)
  assert.equal(value(parseCell('1050', 'scaled', { scale: 0 })), 1050)
  assert.equal(value(parseCell('12.500', 'scaled', { scale: 2 })), 1250)
  assert.equal(reason(parseCell('12.505', 'scaled', { scale: 2 })), 'more than 2 decimal places')
  assert.equal(reason(parseCell('1050.5', 'scaled', { scale: 0 })), 'more than 0 decimal places')
  assert.throws(() => parseCell('1', 'scaled'), /needs a scale/)
})

test('cells: a date and time is ISO 8601 with a zone, on the calendar', function () {
  assert.equal(value(parseCell('2025-10-01T03:45:27Z', 'datetime')), '2025-10-01T03:45:27.000Z')
  assert.equal(value(parseCell('2025-10-01T05:45:27+02:00', 'datetime')), '2025-10-01T03:45:27.000Z')
  assert.equal(value(parseCell('2025-10-01 03:45:27.5-0130', 'datetime')), '2025-10-01T05:15:27.500Z')
  assert.equal(reason(parseCell('2026-02-30T10:00:00Z', 'datetime')), 'not a date on the calendar')
  assert.equal(value(parseCell('2024-02-29T10:00:00Z', 'datetime')), '2024-02-29T10:00:00.000Z')
  assert.equal(reason(parseCell('31/13/2026', 'datetime')), 'not an ISO 8601 date and time')
  assert.equal(reason(parseCell('yesterday', 'datetime')), 'not an ISO 8601 date and time')
  assert.equal(reason(parseCell('2026-01-01T09:00', 'datetime')), 'a time with no zone, so not one instant')
  assert.equal(reason(parseCell('2026-01-01', 'datetime')), 'a date with no time or zone, so not one instant')
})

test('cells: an enum member is exact, case included', function () {
  const values = ['paid', 'pending', 'refunded', 'cancelled']
  assert.equal(value(parseCell('paid', 'enum', { values })), 'paid')
  assert.equal(reason(parseCell('PAID', 'enum', { values })), 'not one of paid, pending, refunded, cancelled')
  assert.equal(reason(parseCell('shipped', 'enum', { values })), 'not one of paid, pending, refunded, cancelled')
})

test('cells: true or false, and nothing that only looks like it', function () {
  assert.equal(value(parseCell('TRUE', 'boolean')), true)
  assert.equal(value(parseCell('0', 'boolean')), false)
  assert.equal(reason(parseCell('yes', 'boolean')), 'not true or false')
})

test('cells: text is kept as it was written, leading zeros and blanks included', function () {
  assert.equal(value(parseCell('0123', 'string')), '0123')
  assert.equal(value(parseCell('', 'string')), '')
  assert.equal(value(parseCell(' x ', 'string')), ' x ')
})

test('cells: blank is null for every kind but text, and the column decides if that is allowed', function () {
  for (const kind of ['int', 'float', 'boolean', 'datetime', 'json'])
    assert.equal(value(parseCell('  ', kind)), null)
  assert.equal(value(parseCell('', 'scaled', { scale: 2 })), null)
  assert.equal(value(parseCell('', 'enum', { values: ['a'] })), null)
})

test('cells: a reason never quotes the cell', function () {
  const secret = '4111-1111-1111-1111'
  for (const kind of ['int', 'float', 'boolean', 'datetime', 'json'])
    assert.equal(reason(parseCell(secret, kind)).includes(secret), false)
  assert.equal(reason(parseCell(secret, 'enum', { values: ['a'] })).includes(secret), false)
})

test('cells: JSON is parsed, or refused without the parser\'s message', function () {
  assert.deepEqual(value(parseCell('{"a":[1,2]}', 'json')), { a: [1, 2] })
  // The parser's own message quotes the offending token.
  assert.equal(reason(parseCell('{"a":', 'json')), 'not JSON')
})
