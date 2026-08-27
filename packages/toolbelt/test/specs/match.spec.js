/*
 * match.spec.js
 *
 * `matchesQuery` — does a pushed record belong in the list a query filled?
 *
 * A live store filled by `load(query)` holds "the rows matching that query", so
 * an event about a row is only an update to that list if the row is still in it
 * (`FJS-011`). The answers are three: in, out, and *cannot be decided from this
 * record* — the one that keeps the guessing out.
 *
 * The operators asserted here are exactly the ones the wire carries — junction's
 * `parseWhere`/`translateOps` and litestone's `buildWhere` between them — and the
 * expectations are what SQL would answer, NULL semantics included: `col != 'x'`
 * does not match a NULL column, `NOT IN` does. Reading them as JavaScript gives
 * the wrong answer for both.
 *
 * Lives here rather than in sierra because there are two live stores and they
 * had one implementation between them (`FJS-493`). What stays in sierra is the
 * SEAM — that `createResource` actually hands this down to junction, built over
 * the model it resolved — which is a fact about sierra's wiring and not about
 * this function.
 */

import { matchesQuery } from '../../src/match/match.js'

const FIELDS = {
  id:        { type: 'integer', required: true },
  name:      { type: 'string' },
  status:    { type: 'string', enum: ['draft', 'active', 'archived'] },
  score:     { type: 'number', nullable: true },
  active:    { type: 'boolean' },
  tags:      { type: 'array' },
  createdAt: { type: 'string', format: 'date-time' },
}

const row = (over = {}) => ({
  id: 1, name: 'Acme', status: 'active', score: 50, active: true,
  tags: ['a', 'b'], createdAt: '2026-08-01T00:00:00.000Z', ...over,
})

const match = (record, query) => matchesQuery(FIELDS, record, query)

test('match: equality — a matching field is in', function () {
  assert.equal(match(row(), { status: 'active' }), true)
})


test('match: equality — a differing field is out', function () {
  assert.equal(match(row({ status: 'draft' }), { status: 'active' }), false)
})


test('match: equality — every key must hold', function () {
  assert.equal(match(row(), { status: 'active', name: 'Acme' }), true)
  assert.equal(match(row(), { status: 'active', name: 'Other' }), false)
})


test('match: equality — an empty query matches everything', function () {
  assert.equal(match(row(), {}), true)
})


test('match: equality — null asks IS NULL', function () {
  assert.equal(match(row({ score: null }), { score: null }), true)
  assert.equal(match(row({ score: 0 }),    { score: null }), false)
})


test('match: equality — a string operand is read as the column type', function () {
  // A query built from a URL or a form control sends strings; SQLite's type
  // affinity converts on comparison and `5 === '5'` does not.
  assert.equal(match(row({ id: 5 }),       { id: '5' }), true)
  assert.equal(match(row({ score: 12.5 }), { score: '12.5' }), true)
  assert.equal(match(row({ active: true }), { active: 'true' }), true)
})


test('match: operators — $in / $nin', function () {
  assert.equal(match(row(), { status: { $in: ['active', 'draft'] } }), true)
  assert.equal(match(row(), { status: { $in: ['draft'] } }), false)
  assert.equal(match(row(), { status: { $nin: ['draft'] } }), true)
})


test('match: operators — $nin matches a NULL column, because NOT IN would not', function () {
  // Litestone ORs `IS NULL` back in for exactly this.
  assert.equal(match(row({ score: null }), { score: { $nin: [1, 2] } }), true)
})


test('match: operators — $ne does not match a NULL column, because != would not', function () {
  assert.equal(match(row({ score: null }), { score: { $ne: 1 } }), false)
  assert.equal(match(row({ score: 2 }),    { score: { $ne: 1 } }), true)
})


test('match: operators — $ne null is IS NOT NULL', function () {
  assert.equal(match(row({ score: 5 }),    { score: { $ne: null } }), true)
  assert.equal(match(row({ score: null }), { score: { $ne: null } }), false)
})


test('match: operators — comparisons', function () {
  assert.equal(match(row({ score: 50 }), { score: { $gte: 50, $lt: 100 } }), true)
  assert.equal(match(row({ score: 50 }), { score: { $gt: 50 } }), false)
  assert.equal(match(row({ score: null }), { score: { $gt: 0 } }), false)
})


test('match: operators — an ISO date column compares as text, which is what the server does', function () {
  assert.equal(match(row(), { createdAt: { $gte: '2026-07-01' } }), true)
  assert.equal(match(row(), { createdAt: { $lt:  '2026-07-01' } }), false)
})


test('match: operators — $like / $start / $end are case-insensitive, as LIKE is', function () {
  assert.equal(match(row(), { name: { $like:  'CM' } }), true)
  assert.equal(match(row(), { name: { $ilike: 'acme' } }), true)
  assert.equal(match(row(), { name: { $start: 'ac' } }), true)
  assert.equal(match(row(), { name: { $end:   'ME' } }), true)
  assert.equal(match(row(), { name: { $like:  'zzz' } }), false)
})


test('match: operators — a bare array is membership, not equality', function () {
  assert.equal(match(row(), { status: ['active', 'draft'] }), true)
  assert.equal(match(row(), { status: ['draft'] }), false)
})


test('match: operators — on an array column a bare array is hasSome', function () {
  assert.equal(match(row(), { tags: ['b', 'z'] }), true)
  assert.equal(match(row(), { tags: ['z'] }), false)
})


test('match: operators — $null', function () {
  assert.equal(match(row({ score: null }), { score: { $null: true } }), true)
  assert.equal(match(row({ score: 1 }),    { score: { $null: true } }), false)
  assert.equal(match(row({ score: 1 }),    { score: { $null: false } }), true)
})


test('match: operators — the bare Litestone spelling reaches the same place', function () {
  // parseWhere only looks for a leading `$`, so an unprefixed operator block
  // travels through to buildWhere untouched.
  assert.equal(match(row(), { score: { gte: 50 } }), true)
  assert.equal(match(row(), { tags: { has: 'a' } }), true)
  assert.equal(match(row(), { tags: { hasNone: ['z'] } }), true)
  assert.equal(match(row(), { tags: { isEmpty: true } }), false)
})


test('match: operators — equals on an array column is the exact set, in order', function () {
  assert.equal(match(row(), { tags: { equals: ['a', 'b'] } }), true)
  assert.equal(match(row(), { tags: { equals: ['b', 'a'] } }), false)
})


test('match: $or / $and / $not — $or', function () {
  assert.equal(match(row(), { $or: [{ status: 'draft' }, { name: 'Acme' }] }), true)
  assert.equal(match(row(), { $or: [{ status: 'draft' }, { name: 'Other' }] }), false)
})


test('match: $or / $and / $not — $and', function () {
  assert.equal(match(row(), { $and: [{ status: 'active' }, { name: 'Acme' }] }), true)
  assert.equal(match(row(), { $and: [{ status: 'active' }, { name: 'Other' }] }), false)
})


test('match: $or / $and / $not — $not', function () {
  assert.equal(match(row(), { $not: { status: 'draft' } }), true)
  assert.equal(match(row(), { $not: { status: 'active' } }), false)
})


test('match: $or / $and / $not — an undecidable branch loses to a decided one, and wins over a false one', function () {
  // `owner` is a relation this record does not carry.
  assert.equal(match(row(), { $or: [{ status: 'active' }, { owner: { name: 'x' } }] }), true)
  assert.equal(match(row(), { $or: [{ status: 'draft' },  { owner: { name: 'x' } }] }), null)
  assert.equal(match(row(), { $and: [{ status: 'draft' }, { owner: { name: 'x' } }] }), false)
})


test('match: what it refuses to decide — a column the record does not carry', function () {
  // A `select` dropped the filtered column — the row is here, the answer is not.
  assert.equal(match({ id: 1, name: 'Acme' }, { status: 'active' }), null)
})


test('match: what it refuses to decide — a filter over a relation', function () {
  assert.equal(match(row(), { owner: { name: 'Jordan' } }), null)
})


test('match: what it refuses to decide — a path into a JSON document', function () {
  assert.equal(match({ ...row(), addr: { city: 'NYC' } }, { addr: { city: 'NYC' } }), null)
})


test('match: what it refuses to decide — $search, $onlyDeleted and $raw', function () {
  assert.equal(match(row(), { $search: 'acme' }), null)
  assert.equal(match(row(), { $onlyDeleted: true }), null)
  assert.equal(match(row(), { $raw: 'price > 100' }), null)
})


test('match: what it refuses to decide — an operator it has never heard of', function () {
  assert.equal(match(row(), { name: { $soundsLike: 'acme' } }), null)
})


test('match: what it refuses to decide — but a decided false still wins — nothing is reloaded to confirm a miss', function () {
  assert.equal(match(row(), { status: 'draft', $search: 'acme' }), false)
})


test('match: what it refuses to decide — a directive is not a filter', function () {
  assert.equal(match(row(), { status: 'active', $limit: 20, $orderBy: 'id' }), true)
})


test('match: what it refuses to decide — no record at all', function () {
  assert.equal(match(null, { status: 'active' }), null)
})


test('match: without a schema — it still matches structurally', function () {
  // A resource with no model resolved has no field rules; what it loses is the
  // string-operand conversion, not the filter.
  assert.equal(matchesQuery({}, row(), { status: 'active' }), true)
  assert.equal(matchesQuery({}, row(), { status: 'draft'  }), false)
  assert.equal(matchesQuery({}, row({ id: 5 }), { id: '5' }), false)
})

