/*
 * sugar.spec.js
 *
 * The tables are called the way an installed method is — `fn.call(value)` —
 * so no prototype is touched and a failure here is the kit's, not the
 * installer's. The legacy cases are the ones a ported frontier app reaches.
 */

import { number, bigint, string, date, array, object, json, func } from '../../src/sugar/sugar.js'
import { createDatetime } from '../../src/datetime/datetime.js'

const call = (table, name, self, ...args) => table.proto[name].call(self, ...args)

// ─── money ─────────────────────────────────────────────────────────────────

test('sugar: toMoney is minor units and toCurrency is major, a hundredfold apart', function () {
  const n = number({ currency: 'USD' })
  assert.equal(call(n, 'toMoney', 1299), '$12.99')
  assert.equal(call(n, 'toCurrency', 12.99), '$12.99')
  assert.equal(call(n, 'toMoney', 5), '$0.05')
})

test('sugar: a call names its own currency over the installed default', function () {
  assert.equal(call(number({ currency: 'USD' }), 'toMoney', 300, 'EUR'), '€3.00')
})

test('sugar: with no default and no currency, a money call throws rather than guessing USD', function () {
  assert.throws(() => call(number(), 'toMoney', 1299), /no currency/)
  assert.throws(() => call(number(), 'toCurrency', 12.99), /no currency/)
})

// ─── round ─────────────────────────────────────────────────────────────────

test('sugar: round shifts the exponent, so 1.005 rounds up where multiplying lost it', function () {
  const n = number()
  assert.equal(call(n, 'round', 1.005, 2), 1.01)
  assert.equal(call(n, 'round', 2.5), 3)
  assert.equal(call(n, 'round', 1234.5678, -2), 1200)
  assert.equal(call(n, 'round', 1e-7, 8), 1e-7)
})

test('sugar: prefix and postfix', function () {
  assert.equal(call(number(), 'prefix', 5, '#'), '#5')
  assert.equal(call(number(), 'postfix', 5, 'px'), '5px')
})

// ─── bigint ────────────────────────────────────────────────────────────────

test('sugar: a BigInt past the safe range throws instead of rounding to another id', function () {
  assert.equal(call(bigint(), 'toJSON', 42n), 42)
  assert.throws(() => call(bigint(), 'toJSON', 2n ** 60n), /MAX_SAFE_INTEGER/)
})

// ─── string ────────────────────────────────────────────────────────────────

test('sugar: casing is inflect, so an initialism stays whole', function () {
  const s = string()
  assert.equal(call(s, 'pascalCase', 'product_variants'), 'ProductVariants')
  assert.equal(call(s, 'camelCase', 'HTTPStatus'), 'httpStatus')
  assert.equal(call(s, 'kebabCase', 'ProductVariant'), 'product-variant')
  assert.equal(call(s, 'snakeCase', 'ProductVariant'), 'product_variant')
  assert.equal(call(s, 'humanCase', 'unitSKU'), 'Unit SKU')
  assert.equal(call(s, 'capitalize', 'hELLO'), 'Hello')
})

test('sugar: is answers the string or empty, for a class toggle', function () {
  assert.equal(call(string(), 'is', 'active', 'active'), 'active')
  assert.equal(call(string(), 'is', 'active', 'paused'), '')
})

test('sugar: initials skip the empty word a double space makes', function () {
  assert.equal(call(string(), 'initials', 'Ada  Lovelace'), 'AL')
  assert.equal(call(string(), 'initials', ''), '')
})

test('sugar: hash is the legacy formula', function () {
  assert.equal(call(string(), 'hash', 'abc'), 96354)
})

test('sugar: isDate refuses a day the calendar does not have', function () {
  const { isDate } = string().statics
  assert.equal(isDate('2025-02-28'), true)
  assert.equal(isDate('2025-02-30'), false)
  assert.equal(isDate('2025-2-3'), false)
  assert.equal(isDate(null), false)
})

test('sugar: dateFormat exists only with a datetime instance', function () {
  assert.equal('dateFormat' in string().proto, false)
  const dt = createDatetime({ timeZone: 'UTC', now: () => 0 })
  assert.equal(call(string({ dt }), 'dateFormat', '2026-09-14T16:05:00Z', 'MMM D, YYYY'), 'Sep 14, 2026')
})

// ─── date ──────────────────────────────────────────────────────────────────

test('sugar: date methods read zone and clock from the instance, never the host', function () {
  const now = Date.UTC(2026, 8, 14, 18, 0)
  const d = date(createDatetime({ timeZone: 'America/Denver', now: () => now }))
  const at = new Date(Date.UTC(2026, 8, 14, 16, 5))
  assert.equal(call(d, 'format', at, 'h:mm aa'), '10:05 AM')
  assert.equal(call(d, 'relativeToNow', at), '1 hour ago')
  assert.equal(d.statics.relativeTo(at, now), '1 hour ago')
})

test('sugar: date() with no instance throws', function () {
  assert.throws(() => date(), /datetime instance/)
})

// ─── array, object, json, function ─────────────────────────────────────────

test('sugar: remove and objectify answer new values and leave the input alone', function () {
  const { remove, objectify } = array().statics
  const items = [{ id: 1 }, { id: 2 }]
  assert.deepEqual(remove(items, { id: 1 }), [{ id: 2 }])
  assert.deepEqual(remove(items, 2), [{ id: 1 }])
  assert.equal(items.length, 2)
  assert.deepEqual(objectify(items, (i) => i.id), { 1: { id: 1 }, 2: { id: 2 } })
})

test('sugar: object statics', function () {
  const { isEmpty, map } = object().statics
  assert.equal(isEmpty({}), true)
  assert.equal(isEmpty(null), true)
  assert.equal(isEmpty({ a: 1 }), false)
  assert.deepEqual(map({ a: 1, b: 2 }, (v, k) => k + v), { a: 'a1', b: 'b2' })
})

test('sugar: JSON.try keeps the legacy answer — objects and booleans only', function () {
  const t = json().statics.try
  assert.deepEqual(t('{"a":1}'), { a: 1 })
  assert.equal(t('true'), true)
  assert.equal(t('5'), undefined)
  assert.equal(t('null'), undefined)
  assert.equal(t('{'), undefined)
})

test('sugar: function statics', function () {
  const f = func()
  assert.equal(f.statics.identity(7), 7)
  assert.equal(f.statics.noop(), undefined)
  // Bun reprints a function's source and node keeps it, so the text differs by
  // runtime; what the method promises is one line with single spaces.
  const printed = call(f, 'printToString', function a () {
    return 1
  })
  assert.equal(/[\n\t]| {2}/.test(printed), false)
  assert.equal(printed.includes('return 1'), true)
})

// ─── every table ───────────────────────────────────────────────────────────

test('sugar: every factory answers proto and statics, and touches no prototype', function () {
  const dt = createDatetime({ timeZone: 'UTC', now: () => 0 })
  const before = Object.getOwnPropertyNames(Number.prototype).length
  for (const t of [number(), bigint(), string(), date(dt), array(), object(), json(), func()]) {
    assert.equal(typeof t.proto, 'object')
    assert.equal(typeof t.statics, 'object')
  }
  assert.equal(Object.getOwnPropertyNames(Number.prototype).length, before)
})
