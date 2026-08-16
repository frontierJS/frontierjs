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
  parseDirectives, splitParams,
} from '../../src/directives/directives.js'

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
