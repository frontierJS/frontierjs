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
  LIMITS, QueryLimitError, isNumericLiteral, parseValue, parseParams,
  parseQueryString, encodePairs, encodeQueryString, normalizeOrderBy,
  readDayToken, dayToken, resolveDayTokens,
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

// `OR[][direction]=…&OR[][type]…` cannot say which element a key belongs to,
// so two branches read back as four and a find over HTTP widened to every row
// the socket filtered out (FJS-2628). A container in an array names its index.
test('query: an array element with more than one key keeps its keys together', function () {
  const q = { OR: [{ direction: 'inbound' }, { direction: 'outbound', type: { notIn: ['email', 'text'] } }] }
  assert.deepEqual(parseQueryString(encodeQueryString(q)), q)
  assert.deepEqual(parseParams(encodePairs(q)), q)
  const nested = { m: [[1, 2], [3]], orderBy: [{ a: 'asc' }, { b: 'desc' }] }
  assert.deepEqual(parseQueryString(encodeQueryString(nested)), nested)
})

test('query: an index names an element, and a gap closes up', function () {
  assert.deepEqual(parseQueryString('?OR[0][a]=1&OR[1][a]=2&OR[0][b]=3'), { OR: [{ a: 1, b: 3 }, { a: 2 }] })
  assert.deepEqual(parseQueryString('?a[3][b]=1'), { a: [{ b: 1 }] })
  assert.deepEqual(parseQueryString('?a[0]=x&a[1]=y'), { a: ['x', 'y'] })
  // not a canonical index, so it stays a key
  assert.deepEqual(parseQueryString('?a[01]=x'), { a: { '01': 'x' } })
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

// FJS-2047: `tasks: { none: {} }` encoded to nothing, so the HTTP fallback
// answered every row where the socket answered the unplaced ones.
test('query: an empty object or array is sent, not dropped', function () {
  const q = { direction: 'inbound', tasks: { none: {} }, cards: { some: {} }, id: { in: [] } }
  assert.equal(encodeQueryString(q), '?direction=inbound&tasks[none]=%7B%7D&cards[some]=%7B%7D&id[in]=[]')
  assert.deepEqual(parseQueryString(encodeQueryString(q)), q)
  assert.deepEqual(parseParams(encodePairs(q)), q)
})

test('query: {} and [] are themselves, and quoted they are text', function () {
  assert.deepEqual(parseValue('{}'), {})
  assert.deepEqual(parseValue('[]'), [])
  // biome-ignore lint/suspicious/noSelfCompare: the comparison asserts identity or stability, which is the point
  assert.ok(parseValue('{}') !== parseValue('{}'), 'each read is a fresh container')
  const pairs = Object.fromEntries(encodePairs({ a: '{}', b: '[]' }))
  assert.equal(pairs.a, '"{}"')
  assert.equal(pairs.b, '"[]"')
  assert.deepEqual(parseQueryString('?a[b]={}&a[c]=1'), { a: { b: {}, c: 1 } })
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

/* ── A point filter ─────────────────────────────────────────────────
 *
 * `FJS-D323` ruled that a proximity search travels as ordinary bracket
 * notation rather than as a compact triple only the geo layer can read. That
 * makes it a claim about THIS module: nothing was added for it, so what has to
 * be pinned is that the shape it produces is the one the Data boundary takes,
 * with the radius still text and the coordinates still numbers.
 */

const NEAR = { site: { near: { lat: 51.5074, lng: -0.1278, within: '5mi' } } }

test('query: a near filter is bracket notation and nothing new', function () {
  const s = encodeQueryString(NEAR)
  assert.ok(s.includes('site[near][lat]=51.5074'), s)
  assert.ok(s.includes('site[near][within]=5mi'), s)
  assert.deepEqual(parseQueryString(s), NEAR)
})

test('query: a radius keeps its unit and a coordinate keeps its type', function () {
  const q = parseQueryString('?site[near][lat]=0&site[near][lng]=-0.1278&site[near][within]=500m')
  assert.equal(typeof q.site.near.lat, 'number', 'null island is a latitude, not an absent one')
  assert.equal(q.site.near.lng, -0.1278)
  assert.equal(q.site.near.within, '500m')
})

test('query: a fixed-precision coordinate stays text, for the model to read', function () {
  // `toFixed(6)` is how a GPS reading reaches a URL and it does not round-trip,
  // so the number rule leaves it alone — correctly, with no model in the room.
  // Litestone's `@point` declaration is what reads it back as a Float; the
  // pinning is here so the two halves cannot drift apart silently.
  const q = parseQueryString('?site[near][lat]=51.507400')
  assert.equal(q.site.near.lat, '51.507400')
})

test('query: a distance ordering survives the round trip', function () {
  const d = { $orderBy: { site: { near: { lat: 51.5074, lng: -0.1278 } } } }
  assert.deepEqual(parseQueryString(encodeQueryString(d)), d)
})

// A bracket key naming an Array.prototype member reached `length` and `map` on
// a real Array, and junction answered the query string with a 500 and a stack
// trace before any gate ran. A named key after an append is a shape conflict,
// so the last write wins, the same as `?a=1&a[b]=2`.
test('query: a bracket key named for an Array.prototype member does not throw', function () {
  assert.deepEqual(parseQueryString('?a[]=1&a[length]=5'), { a: { length: 5 } })
  assert.deepEqual(parseQueryString('?a[]=1&a[map]=x'), { a: { map: 'x' } })
  assert.deepEqual(parseQueryString('?a[]=1&a[b]=2'), { a: { b: 2 } })
  assert.deepEqual(parseQueryString('?a[length]=5&a[]=1'), { a: [1] })
})

/* ── Past a limit is refused, in both directions (FJS-2194) ────────── */

const refused = fn => {
  let err
  try { fn() } catch (e) { err = e }
  assert.ok(err instanceof QueryLimitError, 'throws QueryLimitError, got ' + err)
  assert.equal(err.status, 400)
}

test('query: the encoder refuses depth past the limit rather than writing {}', function () {
  refused(() => encodePairs({ project: { some: { owner: { is: { team: { name: 'red' } } } } } }))
})

test('query: the encoder refuses an array past the item limit', function () {
  const ids = Array.from({ length: LIMITS.items + 1 }, (_, i) => i)
  refused(() => encodeQueryString({ id: { notIn: ids } }))
  assert.equal(encodePairs({ id: { notIn: ids.slice(0, LIMITS.items) } }).length, LIMITS.items)
})

test('query: the encoder refuses more pairs than the parser will read', function () {
  const q = {}
  for (let i = 0; i <= LIMITS.keys; i++) q['k' + i] = i
  refused(() => encodePairs(q))
})

test('query: the parser refuses pairs past the key limit rather than dropping them', function () {
  const pairs = []
  for (let i = 0; i <= LIMITS.keys; i++) pairs.push(['k' + i, '1'])
  refused(() => parseParams(pairs))
  assert.equal(Object.keys(parseParams(pairs.slice(0, LIMITS.keys))).length, LIMITS.keys)
})

test('query: the parser refuses an array past the item limit', function () {
  const qs = '?' + Array.from({ length: LIMITS.items + 1 }, (_, i) => 'id[notIn][]=' + i).join('&')
  refused(() => parseQueryString(qs))
  const rep = '?' + Array.from({ length: LIMITS.items + 1 }, (_, i) => 'id=' + i).join('&')
  refused(() => parseQueryString(rep))
  const objs = '?' + Array.from({ length: LIMITS.items + 1 }, (_, i) => 'a[][b]=' + i).join('&')
  refused(() => parseQueryString(objs))
  // an index past the limit would size a sparse array by what the caller typed
  refused(() => parseQueryString('?a[' + LIMITS.items + '][b]=1'))
})

test('query: normalizeOrderBy reads asc/desc/1/-1 and refuses any other scalar direction', function () {
  assert.deepEqual(normalizeOrderBy({ a: 1, b: -1, c: 'ASC', d: 'Desc' }),
    [{ a: 'asc' }, { b: 'desc' }, { c: 'asc' }, { d: 'desc' }])
  ;['sideways', null, '', 0, true].forEach(dir => {
    assert.throws(() => normalizeOrderBy({ name: dir }), /'name' must be asc/)
  })
  assert.deepEqual(normalizeOrderBy({ author: { name: 'asc' } }), [{ author: { name: 'asc' } }])
})

/* ── A relative day ────────────────────────────────────────────────── */

const AT = { today: '2026-10-28', timeZone: 'America/Denver', kinds: { due: 'date', at: 'instant' } }

test('query: a day token reads and writes its offset, and nothing else is one', function () {
  assert.equal(readDayToken('@today'), 0)
  assert.equal(readDayToken('@today-7'), -7)
  assert.equal(readDayToken('@today+30'), 30)
  ;['@today-', '@today7', '@yesterday', 'today', '@today-1w', -7, null].forEach(v => {
    assert.equal(readDayToken(v), undefined, String(v))
  })
  ;[0, -7, 30].forEach(n => assert.equal(readDayToken(dayToken(n)), n))
  assert.throws(() => dayToken(1.5), /whole number/)
})

test('query: a date column resolves to the day in every operator', function () {
  assert.deepEqual(resolveDayTokens({ due: { gte: '@today-7', lte: '@today' } }, AT),
    { due: { gte: '2026-10-21', lte: '2026-10-28' } })
  assert.deepEqual(resolveDayTokens({ due: '@today+4' }, AT), { due: '2026-11-01' })
  assert.deepEqual(resolveDayTokens({ due: { in: ['@today', '2026-01-01'] } }, AT),
    { due: { in: ['2026-10-28', '2026-01-01'] } })
})

test('query: an instant column resolves to the day\'s first or last moment in the zone', function () {
  // Denver is UTC-6 on the 21st and UTC-7 on the 28th; the fall-back is Nov 1.
  assert.deepEqual(resolveDayTokens({ at: { gte: '@today-7', lte: '@today' } }, AT),
    { at: { gte: '2026-10-21T06:00:00.000Z', lte: '2026-10-29T05:59:59.999Z' } })
  assert.deepEqual(resolveDayTokens({ at: { gt: '@today', lt: '@today' } }, AT),
    { at: { gt: '2026-10-29T05:59:59.999Z', lt: '2026-10-28T06:00:00.000Z' } })
  // across the transition the day is 25 hours, not start + 24h
  assert.deepEqual(resolveDayTokens({ at: '@today+4' }, AT),
    { at: { gte: '2026-11-01T06:00:00.000Z', lte: '2026-11-02T06:59:59.999Z' } })
  assert.deepEqual(resolveDayTokens({ at: { equals: '@today' } }, { ...AT, timeZone: 'UTC' }),
    { at: { gte: '2026-10-28T00:00:00.000Z', lte: '2026-10-28T23:59:59.999Z' } })
})

test('query: only a named date column is rewritten, through the combinators, and the argument is untouched', function () {
  const q = { name: '@today', at: { in: ['@today'] }, $or: [{ due: '@today' }, { name: { contains: '@today' } }] }
  const before = JSON.stringify(q)
  assert.deepEqual(resolveDayTokens(q, AT),
    { name: '@today', at: { in: ['@today'] }, $or: [{ due: '2026-10-28' }, { name: { contains: '@today' } }] })
  assert.equal(JSON.stringify(q), before)
  assert.deepEqual(parseQueryString(encodeQueryString({ due: { gte: '@today-7' } })), { due: { gte: '@today-7' } })
})
