/*
 * directives.spec.js
 *
 * The property is agreement, as it is for inflect: two boundaries read the `$`
 * convention — Junction's bridge and Sierra's router — and a directive one of
 * them does not know about does not fail, it becomes a filter on a column that
 * does not exist. So the cases here are the shapes each caller actually hands
 * in: strings from an HTTP query, already-coerced values from a URL parser.
 */

import {
  DIRECTIVE_PARAMS, TRANSPORT_PARAMS, RESERVED_PARAMS,
  parseDirectives, directiveParams, splitParams, unknownDirectives,
  orderByPair, orderByValue,
} from '../../src/directives/directives.js'
import { parseQueryString } from '../../src/query/query.js'

/* ── The table ─────────────────────────────────────────────────────── */

test('directives: reserved is both kinds, and nothing else', function () {
  assert.equal(RESERVED_PARAMS.size, DIRECTIVE_PARAMS.length + TRANSPORT_PARAMS.length)
  DIRECTIVE_PARAMS.forEach(k => assert.ok(RESERVED_PARAMS.has(k), k + ' is reserved'))
  TRANSPORT_PARAMS.forEach(k => assert.ok(RESERVED_PARAMS.has(k), k + ' is reserved'))
  assert.ok(!RESERVED_PARAMS.has('status'))
})

test('directives: every reserved key starts with $', function () {
  // The `$` IS the rule. A reserved key without one would strip a real column.
  for (const k of RESERVED_PARAMS) assert.equal(k[0], '$')
})

/* ── Reading ───────────────────────────────────────────────────────── */

test('directives: strings, as an HTTP query string delivers them', function () {
  const d = parseDirectives({ $limit: '20', $offset: '40', $orderBy: '-createdAt' })
  assert.deepEqual(d, { limit: 20, offset: 40, orderBy: '-createdAt' })
})

test('directives: already-coerced values, as a URL parser delivers them', function () {
  const d = parseDirectives({ $limit: 20, $withDeleted: true })
  assert.deepEqual(d, { limit: 20, withDeleted: true })
})

test('directives: absent stays absent — nothing asked is not the defaults', function () {
  assert.deepEqual(parseDirectives({}), {})
  assert.deepEqual(parseDirectives({ status: 'active' }), {})
  assert.deepEqual(parseDirectives(null), {})
})

test('directives: a limit of 0 survives — it is count-only, not missing', function () {
  assert.deepEqual(parseDirectives({ $limit: '0' }), { limit: 0 })
})

test('directives: a non-numeric limit is dropped, not passed on as NaN', function () {
  assert.deepEqual(parseDirectives({ $limit: 'lots' }), {})
})

test('directives: the truthy spellings a URL can carry', function () {
  assert.equal(parseDirectives({ $withDeleted: 'true' }).withDeleted, true)
  assert.equal(parseDirectives({ $withDeleted: '1' }).withDeleted, true)
  assert.equal(parseDirectives({ $withDeleted: 'false' }).withDeleted, false)
  assert.equal(parseDirectives({ $onlyDeleted: '0' }).onlyDeleted, false)
})

test('directives: an empty $search is not a search', function () {
  assert.deepEqual(parseDirectives({ $search: '' }), {})
  assert.deepEqual(parseDirectives({ $search: 'acme' }), { search: 'acme' })
})

/* ── Splitting ─────────────────────────────────────────────────────── */

test('directives: one bag becomes the two things it carried', function () {
  const { query, directives } = splitParams({
    status: 'active', tier: 3, $limit: '20', $orderBy: 'name',
  })
  assert.deepEqual(query, { status: 'active', tier: 3 })
  assert.deepEqual(directives, { limit: 20, orderBy: 'name' })
})

test('directives: no half ever contains a $', function () {
  // A directive left among the filters is a WHERE clause on a column nobody
  // declared, reported three layers away as a filter typo.
  const { query } = splitParams({ $limit: '20', $first: '1', $wrap: 'false', a: 1 })
  assert.deepEqual(Object.keys(query), ['a'])
})

test('directives: a transport param is stripped and has no structured form', function () {
  const { query, directives } = splitParams({ $first: 'true' })
  assert.deepEqual(query, {})
  assert.deepEqual(directives, {})
})

test('directives: nothing in, two empties out', function () {
  assert.deepEqual(splitParams(undefined), { query: {}, directives: {} })
})

/* ── The table is the definition ───────────────────────────────────── */

test('directives: every name in the table parses to its own structured field', function () {
  // The three lists were hand-written and could disagree — which is how
  // @@hasTemplates got a Data-realm feature with no wire name at all
  // (FJS-306). One table means a name that exists parses, always.
  for (const param of DIRECTIVE_PARAMS) {
    const d = parseDirectives({ [param]: '1' })
    assert.equal(Object.keys(d).length, 1, param + ' parses to exactly one field')
    assert.equal('$' + Object.keys(d)[0], param, param + ' keeps its own name')
  }
})

test('directives: the template pair reads like the deleted pair', function () {
  assert.equal(parseDirectives({ $onlyTemplates: 'true' }).onlyTemplates, true)
  assert.equal(parseDirectives({ $withTemplates: true }).withTemplates, true)
  assert.equal(parseDirectives({ $onlyTemplates: 'false' }).onlyTemplates, false)
  // …and it is a directive, so it never lands among the filters.
  assert.deepEqual(splitParams({ $onlyTemplates: 'true', name: 'x' }).query, { name: 'x' })
})

// ─── Invariant 10 ─────────────────────────────────────────────────────────────

test('directives: no $-prefixed key survives into the filters', function () {
  // The set of KNOWN directives is not the test — those were always removed,
  // which is why nothing failed. What leaked was every other `$` name, each
  // becoming a WHERE on a column that cannot exist (FJS-988).
  for (const key of ['$nope', '$$limit', '$limitt', '$', '$__proto__']) {
    const { query, directives } = splitParams({ [key]: '1', keep: '2' })
    assert.equal(query[key], undefined, `${key} reached the filters`)
    assert.deepEqual(Object.keys(query), ['keep'])
    assert.equal(Object.keys(directives).length, 0)
  }
  // Controls: a recognized directive still parses, and an ordinary filter is
  // untouched — a split that dropped everything would pass the rows above.
  const r = splitParams({ $limit: '10', status: 'open' })
  assert.deepEqual(r.query, { status: 'open' })
  assert.equal(r.directives.limit, 10)
})

test('directives: a filter named __proto__ survives to the Data boundary', function () {
  // A WS frame's query bag is JSON.parse'd, so `__proto__` arrives as an OWN
  // key. Assignment dropped it AND replaced the filters object's prototype, so
  // `ctx.query` read one way through Object.keys and another through a property
  // access. Carrying it is what lets the boundary refuse it BY NAME, the way it
  // already refuses any other undeclared column (`FJS-996`).
  const frame = JSON.parse('{"__proto__":{"userId":"victim"},"name":"ok","$limit":"5"}')
  const { query, directives } = splitParams(frame)

  assert.deepEqual(Object.keys(query), ['__proto__', 'name'])
  assert.equal(JSON.stringify(query), '{"__proto__":{"userId":"victim"},"name":"ok"}')
  // The object reads the same way whichever way it is read.
  assert.equal(query.userId, undefined)
  assert.equal('userId' in query, false)
  // And the `$` half is still stripped, or this row would pass with the split
  // removed altogether.
  assert.equal(directives.limit, 5)
  assert.equal(query.$limit, undefined)
})

test('directives: the unknown $ names are reported, and the list is THIS table', function () {
  // The kit reports and the boundary refuses — a pure function cannot refuse a
  // request, and the list a refusal names has to be derived from the same table
  // `splitParams` strips by, or it goes stale on the next directive added
  // (`FJS-D237`).
  assert.deepEqual(unknownDirectives({ $limit: '1', $limitt: '2', status: 'x' }), ['$limitt'])
  assert.deepEqual(unknownDirectives({ $offest: '1', $nope: '2' }), ['$offest', '$nope'],
    'every unknown, in arrival order — a refusal naming only the first is two round trips')

  // Controls. A reporter that answered every `$` key would satisfy the rows
  // above and refuse every paginated call in the repo.
  assert.deepEqual(unknownDirectives({ $limit: '1', $orderBy: 'name' }), [])
  assert.deepEqual(unknownDirectives({ $first: '1', $wrap: '1' }), [],
    'a transport param is a name the wire knows, though it is not a directive')
  assert.deepEqual(unknownDirectives({ status: 'x', 'pri$ce': '5' }), [],
    'the PREFIX is the rule, not the character')

  // Every name the table holds is known to the reporter, both ways round.
  for (const name of RESERVED_PARAMS) {
    assert.deepEqual(unknownDirectives({ [name]: '1' }), [], `${name} is known`)
  }
  assert.deepEqual(unknownDirectives(null), [])
})

/* ── Writing ───────────────────────────────────────────────────────── */

test('directives: every name written is a name this table strips', function () {
  // The property that makes the two halves one table. Junction's client held a
  // hand-written copy of the write list and named itself the one table in its
  // own comment; a name emitted there and absent here lands in the WHERE clause
  // as a column nobody declared, three layers from the cause (`FJS-988`).
  const every = {
    limit: 1, offset: 2, after: 'cur', orderBy: { name: 'asc' },
    select: ['a', 'b'], populate: ['c'], search: 'wid',
    withDeleted: true, onlyDeleted: false,
    withTemplates: true, onlyTemplates: false,
  }
  const params = directiveParams(every)

  assert.deepEqual(Object.keys(params).sort(), [...DIRECTIVE_PARAMS].sort(),
    'every row of the table is written, and nothing else is')
  for (const k of Object.keys(params)) assert.ok(RESERVED_PARAMS.has(k), k + ' is stripped')
  assert.deepEqual(splitParams(params).query, {},
    'so nothing it writes survives as a filter')
})

test('directives: a structure travels AS a structure', function () {
  // `encodeQueryString` and the transport's parser are inverses by construction
  // (`FJS-D125`). A JSON string here is not one: the reader takes `$orderBy`
  // as-is, so `[{"sortOrder":"asc"}]` arrived as text, was split on commas and
  // refused as a column name — every non-string orderBy was a 400 (`FJS-962`).
  const p = directiveParams({ orderBy: [{ total: 'desc' }] })
  assert.deepEqual(p.$orderBy, [{ total: 'desc' }])
  assert.ok(typeof p.$orderBy !== 'string')
})

test('directives: the two rows that do not travel as themselves', function () {
  // A list of field names is comma-joined, because the READER takes $select
  // as-is. The control beside it is every other row, which passes through — a
  // writer that joined everything would turn an orderBy object into text.
  const p = directiveParams({ select: ['id', 'name'], populate: ['lines'], search: 'a,b' })
  assert.equal(p.$select, 'id,name')
  assert.equal(p.$populate, 'lines')
  assert.equal(p.$search, 'a,b', 'a comma in a VALUE is not a list')
})

test('directives: absent stays absent, on the way out too', function () {
  // `parseDirectives`' rule in the other direction. A writer that emitted the
  // defaults would turn *no opinion* into an explicit ask on every call.
  assert.deepEqual(directiveParams({}), {})
  assert.deepEqual(directiveParams(null), {})
  assert.deepEqual(directiveParams({ limit: undefined, orderBy: null }), {})
  assert.deepEqual(directiveParams({ limit: 0 }), { $limit: 0 },
    'a limit of 0 is count-only, not missing')
  assert.deepEqual(directiveParams({ onlyDeleted: false }), { $onlyDeleted: false },
    'and false is an answer, which is why the test is null-ish and not truthy')
})

test('directives: a URL round-trips', function () {
  // What a page does: read the directives off a URL, hand them to a component
  // that speaks `$`, take the next query back. A row that survives one
  // direction and not the other loses a person their sort when they type in a
  // filter box, which nothing anywhere reports.
  const url = { $limit: '20', $offset: '40', $orderBy: '-total', $search: 'wid', $withDeleted: 'true' }
  const back = directiveParams(parseDirectives(url))
  assert.deepEqual(parseDirectives(back), parseDirectives(url))
  assert.equal(back.$limit, 20, 'and it comes back TYPED, having been parsed once')
})

/* ── The orderBy pair ──────────────────────────────────────────────── */

test('directives: the pair reads every shape the table admits', function () {
  assert.deepEqual(orderByPair('-name'),         { key: 'name', dir: 'desc' })
  assert.deepEqual(orderByPair('name'),          { key: 'name', dir: 'asc'  })
  assert.deepEqual(orderByPair({ name: 'desc' }), { key: 'name', dir: 'desc' })
  assert.deepEqual(orderByPair([{ name: 'desc' }, { id: 'asc' }]), { key: 'name', dir: 'desc' },
    'the FIRST ordering, because a header marks one column')
  assert.deepEqual(orderByPair(['-name', 'id']), { key: 'name', dir: 'desc' })
})

test('directives: nothing sorted is an empty KEY, not a direction', function () {
  // A caller marking a header tests the key. Answering `{key:'', dir:'asc'}`
  // for *unsorted* and for *ascending by nothing* alike is what lets one test
  // cover both, and there is no third state to confuse it with.
  for (const v of [undefined, null, '', {}, []]) {
    assert.deepEqual(orderByPair(v), { key: '', dir: 'asc' }, JSON.stringify(v))
  }
})

test('directives: the pair is read off a REAL url, which is where it broke', function () {
  // The crossing, and the only shape that could see FJS-1077: `/query` decides
  // what bracket notation MEANS and `/directives` decides what is a directive,
  // so a hand-built object grades neither. Each row is the URL somebody types.
  const pairFor = (qs) => orderByPair(parseDirectives(parseQueryString(qs)).orderBy)

  assert.deepEqual(pairFor('$orderBy=-name'),          { key: 'name', dir: 'desc' })
  assert.deepEqual(pairFor('$orderBy[name]=desc'),     { key: 'name', dir: 'desc' },
    'the shape that THREW: three pages assumed a string and called .replace on it')
  assert.deepEqual(pairFor('$orderBy[0][name]=desc'),  { key: 'name', dir: 'desc' },
    'the shape that answered key "0" and a direction that was itself an object')
  assert.deepEqual(pairFor('$orderBy[0]=-name'),       { key: 'name', dir: 'desc' },
    'bracket indices come back as an object, so Array.isArray is false for a caller who wrote one')
})

test('directives: a numeric key is only residue when the value is not a direction', function () {
  // The ambiguity is real and is decided on the value. `{'0':'desc'}` is a
  // column named 0 sorted descending — absurd, and still better than descending
  // INTO 'desc' and reporting a column by that name.
  assert.deepEqual(orderByPair({ 0: 'desc' }),   { key: '0', dir: 'desc' })
  assert.deepEqual(orderByPair({ 0: '-name' }),  { key: 'name', dir: 'desc' })
})

test('directives: a missing direction is ascending, not unsorted', function () {
  // `?$orderBy[name]=` — the column is named and the direction is not. Losing
  // the key here would unmark a header the URL plainly sorts by.
  assert.deepEqual(orderByPair({ name: '' }), { key: 'name', dir: 'asc' })
  assert.deepEqual(orderByPair({ name: 'DESC' }), { key: 'name', dir: 'desc' },
    'and the direction is read the way a marker reads it, not the way a parser would')
})

test('directives: the pair round-trips through the value a page writes back', function () {
  // Two pages wrote the next sort in two shapes for one click. `orderByValue`
  // is the one spelling, and this is the assertion that it is `orderByPair`'s
  // inverse rather than merely a second opinion.
  for (const [key, dir] of [['name', 'asc'], ['total', 'desc'], ['createdAt', 'desc']]) {
    assert.deepEqual(orderByPair(orderByValue(key, dir)), { key, dir })
  }
  assert.equal(orderByValue(''), undefined,
    'an empty key removes the directive rather than ordering by nothing')
  assert.deepEqual(directiveParams({ orderBy: orderByValue('total', 'desc') }), { $orderBy: '-total' },
    'and what it writes is what the table carries')
})
