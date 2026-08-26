/*
 * query.spec.js
 *
 * The property is agreement in two directions. Three boundaries read this —
 * Junction's bridge off a request, Sierra's router off a URL, Junction's client
 * writing one — so the cases are the shapes each actually hands in, plus the
 * round trip, which is the only thing that keeps the encoder and the parser
 * from drifting.
 *
 * The number cases are the substance. `parseFloat`-based inference is what both
 * boundaries used to do, and every value below marked "stays a string" is one
 * it converted: a SKU, a phone number, a price with cents, a snowflake id.
 */

import {
  LIMITS, isNumericLiteral, parseValue, parseParams,
  parseQueryString, encodePairs, encodeQueryString,
} from '../../src/query/query.js'

/* ── The number rule ───────────────────────────────────────────────── */

test('query: a number is a number when it round-trips', function () {
  ;['5', '0', '-3.25', '0.1', '1000'].forEach(v => {
    assert.ok(isNumericLiteral(v), v + ' is a number')
    assert.equal(parseValue(v), Number(v))
  })
})

test('query: every parseFloat trap stays a string', function () {
  const traps = {
    '007':              'a SKU, not 7',
    '0x10':             'hex, not 16',
    '+1':               'a phone number, not 1',
    '1e5':              'not 100000',
    ' 12 ':             'padding is not a number',
    '1.50':             'money keeps its cents',
    '9007199254740993': 'the round trip loses the last digit',
    'NaN':              'nobody typed this into a filter',
    'Infinity':         'nor this',
    '1,000':            'a separator is not a number',
    '2026-08-23':       'a date is not 2026',
  }
  for (const [v, why] of Object.entries(traps)) {
    assert.equal(isNumericLiteral(v), false, v + ' — ' + why)
    assert.equal(parseValue(v), v, v + ' — ' + why)
  }
})

test('query: the empty string is itself, not zero', function () {
  assert.equal(parseValue(''), '')
  assert.equal(isNumericLiteral(''), false)
})

/* ── The other scalars ─────────────────────────────────────────────── */

test('query: true, false and null are themselves', function () {
  assert.equal(parseValue('true'),  true)
  assert.equal(parseValue('false'), false)
  assert.equal(parseValue('null'),  null)
})

test('query: a quoted value is text, and quoting beats every other rule', function () {
  assert.equal(parseValue('"5"'),     '5')
  assert.equal(parseValue('"true"'),  'true')
  assert.equal(parseValue('"null"'),  'null')
  assert.equal(parseValue('"007"'),   '007')
  assert.equal(parseValue('""'),      '')
})

test('query: a non-string passes through untouched', function () {
  assert.equal(parseValue(5), 5)
  assert.equal(parseValue(true), true)
  assert.equal(parseValue(null), null)
})

/* ── Structure ─────────────────────────────────────────────────────── */

test('query: brackets carry the operator vocabulary', function () {
  assert.deepEqual(
    parseQueryString('?qty[gte]=10&qty[lt]=20&id[in][]=1&id[in][]=2'),
    { qty: { gte: 10, lt: 20 }, id: { in: [1, 2] } }
  )
})

test('query: a repeated key is an array — what a multi-select emits', function () {
  assert.deepEqual(parseQueryString('?tag=x&tag=y&tag=z'), { tag: ['x', 'y', 'z'] })
  assert.deepEqual(parseQueryString('?tag=x'),             { tag: 'x' })
})

test('query: an explicit [] is an array even with one element', function () {
  assert.deepEqual(parseQueryString('?tag[]=x'), { tag: ['x'] })
})

test('query: a bare key is the empty string, not absent', function () {
  assert.deepEqual(parseQueryString('?q'),  { q: '' })
  assert.deepEqual(parseQueryString('?q='), { q: '' })
})

test('query: + is a space and a bad escape stays raw', function () {
  assert.deepEqual(parseQueryString('?name=ada+lovelace'), { name: 'ada lovelace' })
  assert.deepEqual(parseQueryString('?bad=%E0%A4%A'),      { bad: '%E0%A4%A' })
})

test('query: no search string is an empty query', function () {
  assert.deepEqual(parseQueryString(''),  {})
  assert.deepEqual(parseQueryString('?'), {})
})

/* ── Guards ────────────────────────────────────────────────────────── */

test('query: __proto__ cannot be assigned through a bracket path', function () {
  const out = parseQueryString('?__proto__[polluted]=1&a[__proto__][b]=2')
  assert.equal({}.polluted, undefined, 'Object.prototype is untouched')
  assert.equal(out.polluted, undefined)
})

test('query: a path deeper than the limit is kept whole, never truncated', function () {
  const deep = 'a' + '[b]'.repeat(LIMITS.depth + 2) + '=1'
  const out  = parseQueryString('?' + deep)
  // The whole key survives as a filter nobody declared, which the Data boundary
  // reports by name. A truncated path would be a DIFFERENT filter, applied.
  assert.equal(Object.keys(out).length, 1)
  assert.ok(Object.keys(out)[0].includes('[b]'))
})

test('query: a malformed key is kept whole rather than dropped', function () {
  assert.deepEqual(parseQueryString('?a[b=1'), { 'a[b': 1 })
})

/* ── The round trip ────────────────────────────────────────────────── */

const ROUND_TRIP = {
  qty:      5,
  price:    '1.50',
  sku:      '007',
  code:     '5',
  flagged:  true,
  archived: null,
  id:       { in: [1, 2] },
  tag:      ['x', 'y'],
  name:     'ada lovelace',
}

test('query: encode then parse is the identity', function () {
  assert.deepEqual(parseQueryString(encodeQueryString(ROUND_TRIP)), ROUND_TRIP)
})

test('query: parseParams takes the pairs the encoder emits', function () {
  assert.deepEqual(parseParams(encodePairs(ROUND_TRIP)), ROUND_TRIP)
})

test('query: a string that would read back as something else is quoted', function () {
  const pairs = Object.fromEntries(encodePairs({ a: '5', b: 'true', c: 'null', d: 'plain' }))
  assert.equal(pairs.a, '"5"')
  assert.equal(pairs.b, '"true"')
  assert.equal(pairs.c, '"null"')
  assert.equal(pairs.d, 'plain', 'a string that reads back as itself is not quoted')
})

test('query: undefined is dropped and null is sent', function () {
  const pairs = Object.fromEntries(encodePairs({ a: undefined, b: null }))
  assert.equal('a' in pairs, false)
  assert.equal(pairs.b, 'null')
})

test('query: an empty query encodes to no search string', function () {
  assert.equal(encodeQueryString({}), '')
  assert.equal(encodeQueryString(null), '')
})

test('query: $ and brackets are left readable in the URL', function () {
  const s = encodeQueryString({ $limit: 20, qty: { gte: 3 } })
  assert.ok(s.includes('$limit=20'), s)
  assert.ok(s.includes('qty[gte]=3'), s)
})

test('query: a Date is an ISO instant', function () {
  const pairs = Object.fromEntries(encodePairs({ at: new Date('2026-08-23T00:00:00.000Z') }))
  assert.equal(pairs.at, '2026-08-23T00:00:00.000Z')
})
