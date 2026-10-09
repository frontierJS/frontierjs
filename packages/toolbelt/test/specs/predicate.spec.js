/*
 * predicate.spec.js
 *
 * `evaluate` — does this record satisfy a declared `.lite` expression?
 *
 * It was litestone's `evalJs` and moved here because a condition cannot cross
 * to a browser as a VALUE: `@required(where: status == 'shipped')` has to be
 * answered against the record on screen, which changes as somebody types, and
 * neither sierra nor `@frontierjs/ui` may reach litestone's internals.
 *
 * **A move and not a third compilation.** litestone's `evalJs` IS this function
 * with litestone's environment passed in, so the oracle that holds the two
 * compilers together (`test/policy-interpreters.test.ts`, the same predicate
 * over the same rows asked of SQL and of JS) still grades these bytes. What is
 * asserted HERE is the part that oracle cannot see from inside litestone: that
 * the function answers correctly with NOTHING injected, which is the browser's
 * situation.
 *
 * Two things carry almost all the risk and both are counter-intuitive:
 *
 *   • three-valued logic — UNKNOWN is not false, and reading it as false makes
 *     an @@allow fail open exactly where it should fail closed (`FJS-668`)
 *   • SQLite's comparison — affinity is applied and then storage class ordered,
 *     where JS `===` does neither. 54 of 594 measured cells disagreed
 *     (`FJS-713`), so every affinity row here is PAIRED with the JS answer it
 *     must not give
 */

import { evaluate, shiftInstant, compare, truth, and3, or3, not3, parseText, assertValues, evaluateValues, ParseError } from '../../src/predicate/predicate.js'

// The AST shapes here are hand-written, because toolbelt depends on nothing and
// cannot reach litestone's parser to build one. What holds them to what the
// parser actually emits is litestone's own oracle
// (`test/policy-interpreters.test.ts`), which runs REAL parsed schemas through
// this function — and it is the reason a `list`'s `items` below are raw VALUES
// rather than literal nodes, which is what the parser produces and what the
// first draft of this file got wrong.
const lit = (value) => ({ type: 'literal', value })
const fld = (name) => ({ type: 'field', name })
const cmp = (left, op, right) => ({ type: 'compare', left, op, right })
const and = (left, right) => ({ type: 'and', left, right })
const or  = (left, right) => ({ type: 'or', left, right })
const not = (expr) => ({ type: 'not', expr })

const ROW = { status: 'shipped', qty: 5, note: null, tags: ['a', 'b'] }
const on  = (node, over = {}) => evaluate(node, { record: { ...ROW, ...over } })

// ── the ordinary answers ─────────────────────────────────────────────────────

test('predicate: a column equal to a literal', function () {
  assert.equal(on(cmp(fld('status'), '==', lit('shipped'))), true)
  assert.equal(on(cmp(fld('status'), '==', lit('draft'))), false)
})

test('predicate: and / or / not', function () {
  const shipped = cmp(fld('status'), '==', lit('shipped'))
  const big     = cmp(fld('qty'), '>', lit(3))
  assert.equal(on(and(shipped, big)), true)
  assert.equal(on(and(shipped, cmp(fld('qty'), '>', lit(99)))), false)
  assert.equal(on(or(cmp(fld('status'), '==', lit('draft')), big)), true)
  assert.equal(on(not(shipped)), false)
})

test('predicate: a ternary chooses a value', function () {
  const node = { type: 'ternary', cond: cmp(fld('status'), '==', lit('shipped')),
                 then: lit(true), else: lit(false) }
  assert.equal(on(node), true)
})

// ── three-valued logic ───────────────────────────────────────────────────────
//
// The pairs are the test. `null` where a boolean was expected is the answer
// that makes an @@allow fail closed and a @@deny fire, and a reader that
// collapsed it to false would pass every row above.

test('predicate: a comparison against an absent value is UNKNOWN, not false', function () {
  assert.equal(on(cmp(fld('note'), '==', lit('x'))), null)
  assert.equal(on(cmp(fld('note'), '!=', lit('x'))), null)
  // the pair: present and different really is false
  assert.equal(on(cmp(fld('status'), '!=', lit('shipped'))), false)
})

test('predicate: UNKNOWN propagates through and/or the way SQL says', function () {
  const unknown = cmp(fld('note'), '==', lit('x'))
  const yes     = cmp(fld('status'), '==', lit('shipped'))
  const no      = cmp(fld('status'), '==', lit('draft'))
  assert.equal(on(and(unknown, no)), false)   // FALSE AND UNKNOWN is FALSE
  assert.equal(on(and(unknown, yes)), null)   // TRUE  AND UNKNOWN is UNKNOWN
  assert.equal(on(or(unknown, yes)), true)    // TRUE  OR  UNKNOWN is TRUE
  assert.equal(on(or(unknown, no)), null)     // FALSE OR  UNKNOWN is UNKNOWN
  assert.equal(on(not(unknown)), null)        // NOT UNKNOWN is UNKNOWN
})

test('predicate: `== null` is IS NULL and answers a BOOLEAN', function () {
  // The one comparison that decides over an absent value — without it there is
  // no way to write "this column is not set" at all.
  assert.equal(on(cmp(fld('note'), '==', lit(null))), true)
  assert.equal(on(cmp(fld('note'), '!=', lit(null))), false)
  assert.equal(on(cmp(fld('status'), '==', lit(null))), false)
  assert.equal(on(cmp(fld('status'), '!=', lit(null))), true)
})

test('predicate: the 3VL helpers, directly', function () {
  assert.equal(truth(null), null)
  assert.equal(truth(0), false)
  assert.equal(and3(false, null), false)
  assert.equal(and3(true, null), null)
  assert.equal(or3(true, null), true)
  assert.equal(or3(false, null), null)
  assert.equal(not3(null), null)
})

// ── SQLite's comparison ──────────────────────────────────────────────────────

test('predicate: NUMERIC affinity pulls the other operand to a number', function () {
  // The measured case: a principal carries its id as TEXT and the column is an
  // integer. JS `===` says false; SQLite says true, and the boundary agrees
  // with SQLite (`FJS-713`).
  assert.equal(compare(5, '==', '5', 'NUMERIC', null), true)
  assert.equal(5 === '5', false)              // the answer it must not give
  assert.equal(compare('5', '==', 5, null, 'NUMERIC'), true)
})

test('predicate: NUMERIC affinity leaves text that is not a number alone', function () {
  // …which is what makes `qty < 'abc'` TRUE rather than unknown: the operand
  // stays TEXT and TEXT outranks INTEGER.
  assert.equal(compare(5, '<', 'abc', 'NUMERIC', null), true)
})

test('predicate: a NaN operand is unknown, as SQLite binds it NULL', function () {
  // Ranked by value, NaN is neither less nor greater than anything, so it read
  // as EQUAL to every number and `qty <= NaN` admitted any qty (FJS-2185).
  for (const op of ['==', '<=', '>=', '<', '>', '!=']) {
    assert.equal(compare(7, op, NaN), null)
    assert.equal(compare(NaN, op, 7, 'NUMERIC', null), null)
  }
})

test('predicate: TEXT affinity pushes an unaffinitied operand to text', function () {
  assert.equal(compare('5', '==', 5, 'TEXT', null), true)
})

test('predicate: with NO affinity it orders by storage class', function () {
  // NULL < INTEGER/REAL < TEXT < BLOB. A number is never equal to a string and
  // is always less than one.
  assert.equal(compare(5, '==', '5'), false)
  assert.equal(compare(5, '<', '5'), true)
})

test('predicate: a boolean is 0/1 and a Date is its ISO text', function () {
  assert.equal(compare(true, '==', 1), true)
  assert.equal(compare(new Date('2026-01-01T00:00:00.000Z'), '==', '2026-01-01T00:00:00.000Z'), true)
})

test('predicate: a value with no storage class keeps JavaScript\'s answer', function () {
  // Two distinct Buffers rank EQUAL under a class comparison, which would make
  // `==` true for them. This is the branch that stops that.
  const a = new Uint8Array([1]), b = new Uint8Array([1])
  assert.equal(compare(a, '==', b), false)
  assert.equal(compare(a, '==', a), true)
})

test('predicate: affinity reaches the evaluator through the injected reader', function () {
  const node = cmp(fld('qty'), '==', lit('5'))
  assert.equal(evaluate(node, { record: { qty: 5 } }), false)                       // no affinity
  // A literal has NO affinity — only a column has one, which is what
  // litestone's own reader answers. Giving both sides NUMERIC coerces neither,
  // because the rule is *one side has it and the other does not*.
  const colOnly = (n) => (n.type === 'field' ? 'NUMERIC' : null)
  assert.equal(evaluate(node, { record: { qty: 5 }, affinityOf: colOnly }), true)
  assert.equal(evaluate(node, { record: { qty: 5 }, affinityOf: () => 'NUMERIC' }), false)
})

// ── membership ───────────────────────────────────────────────────────────────

test('predicate: `in` over a written list', function () {
  const node = cmp(fld('status'), 'in', { type: 'list', items: ['draft', 'shipped'] })
  assert.equal(on(node), true)
  assert.equal(on(node, { status: 'cancelled' }), false)
})

test('predicate: `in` over an array column, and over its serialized form', function () {
  const node = cmp(lit('a'), 'in', fld('tags'))
  assert.equal(on(node), true)
  assert.equal(on(node, { tags: '["a","b"]' }), true)
  assert.equal(on(node, { tags: ['x'] }), false)
})

test('predicate: an absent needle is UNKNOWN, and a NULL in the list is too', function () {
  assert.equal(on(cmp(fld('note'), 'in', { type: 'list', items: ['a'] })), null)
  // present, no hit, but the list carries an UNKNOWN — so the answer is unknown
  assert.equal(on(cmp(fld('status'), 'in', { type: 'list', items: ['x', null] })), null)
  // the pair: no NULL in the list and the answer is a plain false
  assert.equal(on(cmp(fld('status'), 'in', { type: 'list', items: ['x'] })), false)
})

// ── the principal ────────────────────────────────────────────────────────────

test('predicate: auth() and auth().field', function () {
  const env = { record: { ownerId: 7 }, auth: { id: 7, role: 'admin' } }
  assert.equal(evaluate(cmp(fld('ownerId'), '==', { type: 'auth', field: null }), env), true)
  assert.equal(evaluate(cmp({ type: 'auth', field: 'role' }, '==', lit('admin')), env), true)
  assert.equal(evaluate(cmp({ type: 'auth', field: null }, '!=', lit(null)), env), true)
})

test('predicate: with NO principal, a claim is absent and `== null` says so', function () {
  const env = { record: { ownerId: 7 } }
  assert.equal(evaluate(cmp(fld('ownerId'), '==', { type: 'auth', field: null }), env), null)
  assert.equal(evaluate(cmp({ type: 'auth', field: 'role' }, '==', lit(null)), env), true)
})

test('predicate: columnOf is how a belongsTo field finds its foreign key', function () {
  const node = cmp(fld('owner'), '==', { type: 'auth', field: null })
  const env  = { record: { ownerId: 7 }, auth: { id: 7 }, columnOf: (n) => (n === 'owner' ? 'ownerId' : n) }
  assert.equal(evaluate(node, env), true)
  // the pair: without the mapping there is no such key and the answer is unknown
  assert.equal(evaluate(node, { record: { ownerId: 7 }, auth: { id: 7 } }), null)
})

test('predicate: `owner == null` reads the foreign key, as the SQL half compiles it', function () {
  const env = { columnOf: (n) => (n === 'owner' ? 'ownerId' : n) }
  assert.equal(evaluate(cmp(fld('owner'), '==', lit(null)), { ...env, record: { ownerId: 7 } }), false)
  assert.equal(evaluate(cmp(fld('owner'), '==', lit(null)), { ...env, record: { ownerId: null } }), true)
  assert.equal(evaluate(cmp(lit(null), '!=', fld('owner')), { ...env, record: { ownerId: 7 } }), true)
})

// ── the two nodes that read another model ────────────────────────────────────
//
// Each opens a database on the server, which is why neither could move. Their
// DEFAULTS are the answers litestone gives when the hop cannot be made, and
// they fall opposite ways on purpose: a path yields a VALUE and this language
// spells absent as null, so an allow fails closed; a `check()` is a PREDICATE
// and the SQL half allows when the target has no policy.

test('predicate: an unresolved path is null, an unresolved check is true', function () {
  assert.equal(evaluate({ type: 'path', rel: 'customer', name: 'tier' }, { record: {} }), null)
  assert.equal(evaluate({ type: 'check', field: 'customer' }, { record: {} }), true)
})

// A `some` is a predicate like `check()`, but it asks whether a row EXISTS —
// with no database to ask, the answer is unknown, and an allow fails closed.
test('predicate: an unresolved some is null, and the caller answers it', function () {
  const node = { type: 'some', rel: 'members', where: lit(true) }
  assert.equal(evaluate(node, { record: {} }), null)
  assert.equal(evaluate(node, { record: {}, resolveSome: () => true }), true)
})

test('predicate: both are the caller\'s to answer', function () {
  const env = {
    record: {},
    resolvePath:  () => 'gold',
    resolveCheck: () => false,
  }
  assert.equal(evaluate(cmp({ type: 'path', rel: 'customer', name: 'tier' }, '==', lit('gold')), env), true)
  assert.equal(evaluate({ type: 'check', field: 'customer' }, env), false)
})

// ── the refusal ──────────────────────────────────────────────────────────────

test('predicate: an unknown node type THROWS rather than answering true', function () {
  // Answering `true` and calling it conservative is the opposite: the two
  // compilers cover disjoint operations, so a node added to the grammar and to
  // the SQL half alone would make every create policy holding it a silent
  // no-op (`FJS-635`).
  let threw = false
  try { evaluate({ type: 'nosuchnode' }, { record: {} }) } catch { threw = true }
  assert.ok(threw, 'an unknown node must refuse')
})

test('predicate: now() + a duration moves the instant, and a month overflows as SQLite does', function () {
  const NOW = '2026-01-31T12:00:00.000Z'
  const shift = (sign, value, unit) => ({ type: 'shift', expr: { type: 'now' }, sign, value, unit })
  assert.equal(evaluate(shift(1, 2, 'd'),    { now: NOW }), '2026-02-02T12:00:00.000Z')
  assert.equal(evaluate(shift(-1, 90, 'min'), { now: NOW }), '2026-01-31T10:30:00.000Z')
  assert.equal(evaluate(shift(1, 1, 'wk'),   { now: NOW }), '2026-02-07T12:00:00.000Z')
  assert.equal(evaluate(shift(1, 1, 'mo'),   { now: NOW }), '2026-03-03T12:00:00.000Z')
  assert.equal(evaluate(shift(1, 1, 'yr'),   { now: NOW }), '2027-01-31T12:00:00.000Z')
  assert.equal(evaluate(shift(1, 2, 'd'),    { now: null }), null)
  assert.equal(shiftInstant('not a date', { sign: 1, value: 1, unit: 'd' }), null)
})

// ── a value template: text in, values out (FJS-1998) ─────────────────────────

const NAMES = { contact: ['name', 'email'], agent: ['name'] }
const DATA  = { contact: { name: 'Ada', email: null }, agent: { name: 'Sam' } }
const refuses = (fn, said) => assert.throws(() => { try { fn() } catch (e) { assert.equal(e instanceof ParseError, true); throw e } }, said)
const valueOf = (src) => { const ast = parseText(src); assertValues(ast, NAMES); return evaluateValues(ast, DATA) }

test('values: text parses without a caller-written cursor, and a ternary over names answers', function () {
  assert.equal(valueOf('contact.name'), 'Ada')
  assert.equal(valueOf("contact.email ? contact.email : 'none'"), 'none')
  assert.equal(valueOf("contact.name == 'Ada' && agent.name == 'Sam'"), true)
})

test('values: text with a token left over is refused, not run as its first half', function () {
  refuses(() => parseText("contact.name 'x'"), /after the expression/)
})

test('values: auth(), now(), check(), .some() and a bare name are refused by name', function () {
  const cases = [['auth().id', /auth\(\)/], ['now()', /now\(\)/], ['now() + 2d', /now\(\)/], ['check(contact)', /check\(\)/], ['contact.some(name == 1)', /some/], ['name', /bare name/]]
  for (const [src, said] of cases) refuses(() => assertValues(parseText(src), NAMES), said)
})

test('values: a name outside the closed list is refused, own keys only', function () {
  refuses(() => assertValues(parseText('contact.phone'), NAMES), /contact.phone is not a name/)
  refuses(() => assertValues(parseText('constructor.constructor'), NAMES), /not a name/)
  refuses(() => assertValues(parseText('toString.name'), NAMES), /not a name/)
})

test('values: evaluateValues re-refuses what assertValues would, so a skipped save check cannot render it', function () {
  refuses(() => evaluateValues(parseText('auth().id'), DATA), /auth\(\)/)
  refuses(() => evaluateValues(parseText('constructor.name'), DATA), /not a name/)
})
