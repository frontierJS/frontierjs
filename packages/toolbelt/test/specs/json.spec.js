/*
 * json.spec.js
 *
 * Two properties are under test and everything else serves them.
 *
 *   1. A write never touches the document it was handed, and never loses key
 *      order. Both halves were bugs in the tree this kit replaces: an in-place
 *      rename sent the field to the end of the object, and an in-place removal
 *      found its target by value identity.
 *   2. A path identifies exactly one node. A viewer keyed by a colliding path
 *      shows one row where there are two, and toggles both at once.
 */

import {
  accessorPath, arrayKind, classify, coerceLike, convertTo, diffDocs, expandToDepth, format, getIn,
  insertIn, isContainer, jsonPointer, markRuns, mergeKeys, pathKey, preview, removeIn, renameKey,
  sameValue, searchDoc, setIn, summarize, treeRows, tryParse,
} from '../../src/json/json.js'

// ── classify ──────────────────────────────────────────────────────────────────

test('json: null is its own kind, not an object', function () {
  // `typeof null === 'object'` has never been what a caller meant, and a viewer
  // that believes it walks `null`'s keys and renders an empty object.
  assert.equal(classify(null), 'null')
  assert.equal(classify(undefined), 'null')
  assert.equal(classify({}), 'object')
  assert.equal(classify([]), 'array')
  assert.equal(classify(new Date()), 'date')
  assert.equal(classify(0), 'number')
  assert.equal(classify(''), 'string')
  assert.equal(classify(false), 'boolean')
})

test('json: a value JSON cannot carry is named rather than rendered', function () {
  // A function and a symbol vanish from JSON.stringify and a bigint throws, so
  // showing them as values describes a document that cannot be saved.
  assert.equal(classify(() => {}), 'unsupported')
  assert.equal(classify(Symbol('x')), 'unsupported')
  assert.equal(classify(10n), 'unsupported')
})

test('json: a Date is a leaf, not an empty object', function () {
  // Object.keys(new Date()) is [] — walked as an object, an instant renders as
  // `{}` and the value is gone off the screen with nothing saying so.
  assert.ok(!isContainer(new Date()))
})

// ── arrayKind / mergeKeys ─────────────────────────────────────────────────────

test('json: an array is classified by what a control could do with it', function () {
  assert.equal(arrayKind([]), 'empty')
  assert.equal(arrayKind([{ a: 1 }, { b: 2 }]), 'objects')
  assert.equal(arrayKind(['a', 2, null]), 'primitives')
  assert.equal(arrayKind([{ a: 1 }, 'loose']), 'mixed')
  assert.equal(arrayKind('not one'), 'not-an-array')
})

test('json: a nested array counts as a container, so [[1],[2]] is not primitives', function () {
  // Drawing it as a list of primitives would render each row as `[object]` and
  // offer a text box that destroys the inner array on the first keystroke.
  assert.equal(arrayKind([[1], [2]]), 'objects')
})

test('json: columns are the union of keys in first-appearance order', function () {
  const rows = [{ b: 1, a: 2 }, { c: 3, a: 4 }]
  assert.deepEqual(mergeKeys(rows), ['b', 'a', 'c'])
})

test('json: a row that is not an object contributes no columns', function () {
  assert.deepEqual(mergeKeys([{ a: 1 }, 7, null, ['x']]), ['a'])
  assert.deepEqual(mergeKeys('not rows'), [])
})

// ── tryParse ──────────────────────────────────────────────────────────────────

test('json: every JSON document parses, including the scalar ones', function () {
  // The legacy tryParseJSON answered `undefined` for all four of these, so a
  // column holding `42` or `"text"` read as invalid JSON and could not be
  // edited at all.
  for (const [text, expected] of [['42', 42], ['"text"', 'text'], ['true', true], ['null', null]]) {
    const out = tryParse(text)
    assert.ok(out.ok, `${text} was rejected: ${out.error}`)
    assert.equal(out.value, expected)
  }
})

test('json: a valid null document is not confused with a failure', function () {
  // One return channel for both is how an editor silently discards a document.
  const good = tryParse('null')
  const bad  = tryParse('{oops')
  assert.ok(good.ok && good.value === null)
  assert.ok(!bad.ok)
  assert.ok(bad.error.length > 0, 'a refusal with no reason cannot be rendered')
})

test('json: a parse failure carries a position where the engine gave one', function () {
  const out = tryParse('{"a": 1, }')
  assert.ok(!out.ok)
  assert.ok(out.position === null || Number.isInteger(out.position))
})

// ── coerceLike ────────────────────────────────────────────────────────────────

test('json: an edit keeps the type of the value it replaces', function () {
  // Without this, every edit degrades one type: a number becomes "42" and a
  // boolean becomes "false", which is truthy.
  assert.equal(coerceLike(1, '42'), 42)
  assert.equal(coerceLike(true, 'false'), false)
  assert.equal(coerceLike(null, 'null'), null)
  assert.equal(coerceLike('text', 'other'), 'other')
})

test('json: a half-typed number stays text rather than being refused', function () {
  // `-` and `1.` are both prefixes of a number and neither is one. Coercing
  // them to NaN, or refusing the keystroke, traps the person mid-edit.
  assert.equal(coerceLike(1, '-'), '-')
  assert.equal(coerceLike(1, ''), '')
})

test('json: a container edited as text is only adopted once it parses', function () {
  assert.deepEqual(coerceLike({ a: 1 }, '{"a":2}'), { a: 2 })
  assert.equal(coerceLike({ a: 1 }, '{"a":'), '{"a":')
})

// ── paths ─────────────────────────────────────────────────────────────────────

test('json: two different nodes never share a path key', function () {
  // The naive `path.join('.')` collapses these onto "a.b", so a view keyed by
  // it renders one row for two nodes and expands both at once. Same injectivity
  // argument /history makes about an occurrence key.
  assert.ok(pathKey(['a.b']) !== pathKey(['a', 'b']))
  assert.ok(pathKey(['a', 0]) !== pathKey(['a', '0']))
})

test('json: getIn stops at a non-container rather than throwing', function () {
  const doc = { a: { b: [10, 20] } }
  assert.equal(getIn(doc, ['a', 'b', 1]), 20)
  assert.equal(getIn(doc, ['a', 'b', 9]), undefined)
  assert.equal(getIn(doc, ['a', 'b', 1, 'nope']), undefined)
})

// ── writes ────────────────────────────────────────────────────────────────────

test('json: setIn does not touch the document it was handed', function () {
  // The property the whole kit rests on. An in-place write reaches a reactive
  // runtime as a value === to the one it replaced, so nothing re-renders.
  const doc  = { a: { b: 1 }, c: 2 }
  const next = setIn(doc, ['a', 'b'], 9)

  assert.equal(doc.a.b, 1, 'the original was mutated')
  assert.equal(next.a.b, 9)
  assert.ok(next !== doc && next.a !== doc.a)
  // Everything beside the path is shared — a one-cell edit copies the depth of
  // the tree, not the tree.
  assert.ok(next.c === doc.c)
})

test('json: setIn refuses to invent a container', function () {
  // Creating the missing object instead turns a typo into a restructured
  // document that saves without a word.
  assert.throws(() => setIn({ a: 1 }, ['a', 'b'], 2), /cannot descend/)
  assert.throws(() => setIn({ a: [] }, ['a', 3], 2), /not an index/)
})

test('json: removing an array item removes the one that was clicked', function () {
  // The legacy tree removed by identity — findIndex(v => v === value) — so
  // clicking the third "a" here deleted the first.
  const doc  = { tags: ['a', 'b', 'a'] }
  const next = removeIn(doc, ['tags', 2])

  assert.deepEqual(next.tags, ['a', 'b'])
  assert.deepEqual(doc.tags, ['a', 'b', 'a'], 'the original was mutated')
})

test('json: removing an object key leaves the rest in order', function () {
  const next = removeIn({ a: 1, b: 2, c: 3 }, ['b'])
  assert.deepEqual(Object.keys(next), ['a', 'c'])
})

test('json: removing something that is not there changes nothing', function () {
  const doc = { a: 1 }
  assert.ok(removeIn(doc, ['nope']) === doc)
  assert.ok(removeIn(doc, []) === doc)
})

test('json: a rename keeps the key where it was', function () {
  // delete + set sends the key to the end, so correcting a typo in the first
  // field moves it to the bottom of the form with no way to put it back.
  const next = renameKey({ first: 1, secnd: 2, third: 3 }, [], 'secnd', 'second')
  assert.deepEqual(Object.keys(next), ['first', 'second', 'third'])
  assert.equal(next.second, 2)
})

test('json: a rename onto an existing key is refused, not silently merged', function () {
  assert.throws(() => renameKey({ a: 1, b: 2 }, [], 'a', 'b'), /already exists/)
})

test('json: a rename into a nested object leaves its parent intact', function () {
  const doc  = { meta: { x: 1, y: 2 }, other: true }
  const next = renameKey(doc, ['meta'], 'x', 'z')
  assert.deepEqual(Object.keys(next.meta), ['z', 'y'])
  assert.equal(doc.meta.x, 1, 'the original was mutated')
  assert.ok(next.other === doc.other)
})

test('json: insertIn appends and refuses a non-array', function () {
  assert.deepEqual(insertIn({ list: [1] }, ['list'], 2).list, [1, 2])
  assert.throws(() => insertIn({ obj: {} }, ['obj'], 1), /not an array/)
})

// ── the flattened tree ────────────────────────────────────────────────────────

test('json: a closed document is one row per top-level entry', function () {
  const rows = treeRows({ a: 1, b: { c: 2 } })
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map(r => r.name), ['a', 'b'])
  assert.ok(rows[1].container && !rows[1].open)
})

test('json: only an opened container contributes its children', function () {
  const doc      = { a: { b: { c: 1 } } }
  const expanded = new Set([pathKey(['a'])])
  const rows     = treeRows(doc, { expanded })

  assert.deepEqual(rows.map(r => r.name), ['a', 'b'])
  assert.deepEqual(rows.map(r => r.depth), [0, 1])
})

test('json: every row of a document carries a distinct key', function () {
  // The `{#each}` key. A duplicate is how Pagination shipped two ellipses that
  // shared one (FJS-315), and here it would also toggle two rows at once.
  const doc = { 'a.b': 1, a: { b: 2 }, list: [1, 2] }
  const expanded = new Set([pathKey(['a']), pathKey(['list'])])
  const keys = treeRows(doc, { expanded }).map(r => r.key)

  assert.equal(new Set(keys).size, keys.length, `duplicate row key in ${JSON.stringify(keys)}`)
})

test('json: a scalar document is one row', function () {
  const rows = treeRows(42)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].value, 42)
  assert.equal(rows[0].name, null)
})

test('json: a cycle is a marked leaf, not a hung tab', function () {
  // A value handed to a viewer is not necessarily a parsed one, and recursing
  // into a cycle takes the browser with it.
  const doc = { name: 'root' }
  doc.self = doc

  const rows = treeRows(doc, { expanded: new Set([pathKey(['self'])]) })
  const self = rows.find(r => r.name === 'self')

  assert.ok(self.circular, 'the cycle was not detected')
  assert.ok(!self.open, 'a circular row must not be walked')
  assert.equal(rows.length, 2)
})

test('json: a value repeated at two paths is not a cycle', function () {
  // Only an ancestor counts. Sharing one object between two keys is ordinary,
  // and a seen-set that never forgets renders the second one as circular.
  const shared = { x: 1 }
  const doc    = { a: shared, b: shared }
  const rows   = treeRows(doc, { expanded: new Set([pathKey(['a']), pathKey(['b'])]) })

  assert.ok(rows.every(r => !r.circular), 'a shared value was reported as a cycle')
  assert.equal(rows.length, 4)
})

test('json: expandToDepth seeds the set and stops where it is told', function () {
  const doc = { a: { b: { c: 1 } }, d: [[2]] }

  assert.equal(expandToDepth(doc, 0).size, 0)
  assert.deepEqual([...expandToDepth(doc, 1)].sort(), [pathKey(['a']), pathKey(['d'])].sort())

  const two = expandToDepth(doc, 2)
  assert.ok(two.has(pathKey(['a', 'b'])) && two.has(pathKey(['d', 0])))
  assert.ok(!two.has(pathKey(['a', 'b', 'c'])), 'a leaf must not be in the open set')
})

test('json: expandToDepth terminates on a cycle', function () {
  const doc = { a: {} }
  doc.a.parent = doc
  assert.ok(expandToDepth(doc, 10).size > 0)
})

// ── summarize / preview / format ──────────────────────────────────────────────

test('json: a container summarises to its size', function () {
  assert.deepEqual(summarize([1, 2, 3]), { kind: 'array', size: 3, preview: '[1,2,3]' })
  assert.equal(summarize({ a: 1 }).size, 1)
  assert.equal(summarize('x').size, null)
})

test('json: a preview is clipped and never throws', function () {
  const long = preview({ text: 'x'.repeat(200) })
  assert.ok(long.length <= 80, `preview was ${long.length} chars`)

  const cyclic = {}
  cyclic.self = cyclic
  assert.equal(preview(cyclic), '[object]')
})

test('json: format answers text for anything a view might hold', function () {
  assert.equal(format({ a: 1 }), '{\n  "a": 1\n}')
  // undefined stringifies to undefined, not to a string — a textarea bound to
  // that renders the word "undefined" as the document's content.
  assert.equal(format(undefined), '')

  const cyclic = {}
  cyclic.self = cyclic
  assert.equal(format(cyclic), '')
})

// ─── diffDocs ─────────────────────────────────────────────────────────

test('diffDocs: the merged document carries what was REMOVED', () => {
  // The reason merged exists at all. A removed key is in neither `after` nor
  // any tree built from it, so a viewer handed only the new document shows
  // every change except the ones that took something away.
  const d = diffDocs({ keep: 1, gone: 'x' }, { keep: 1 })
  assert.equal(d.merged.gone, 'x')
  assert.equal(d.status[pathKey(['gone'])], 'removed')
  assert.equal(d.previous[pathKey(['gone'])], 'x')
  assert.equal(d.status[pathKey(['keep'])], undefined, 'an unchanged key is absent, not "same"')
})

test('diffDocs: a key order that survives — before first, then what is new', () => {
  const d = diffDocs({ a: 1, b: 2 }, { b: 2, a: 1, c: 3 })
  assert.deepEqual(Object.keys(d.merged), ['a', 'b', 'c'])
})

test('diffDocs: a change deep down opens every row above it', () => {
  const d = diffDocs({ n: { m: { deep: 1 } } }, { n: { m: { deep: 2 } } })
  // The row that changed does not need to be open — the ones above it do.
  assert.deepEqual(d.open.sort(), [pathKey(['n']), pathKey(['n', 'm'])].sort())
})

test('diffDocs: a container rolls up, and is not counted twice', () => {
  const d = diffDocs({ n: { deep: 1 } }, { n: { deep: 2 } })
  assert.equal(d.status[pathKey(['n'])], 'changed', 'a collapsed branch says something moved')
  assert.equal(d.count.changed, 1, 'and the count is the leaf, not the leaf plus its parents')
})

test('diffDocs: a container that changed KIND is one change, not a whole subtree', () => {
  // Nothing below corresponds, so recursing would report every descendant of
  // both sides as a difference.
  const d = diffDocs({ x: { a: 1 } }, { x: [1] })
  assert.equal(d.status[pathKey(['x'])], 'changed')
  assert.equal(d.count.changed, 1)
  assert.equal(d.status[pathKey(['x', 'a'])], undefined)
})

test('diffDocs: arrays compare by POSITION, and that is a stated limitation', () => {
  // Removing the first of three reads as two changes and one removal. True
  // about the document, and not the most useful reading — an LCS pass is a
  // different feature and is deliberately not guessed at.
  const d = diffDocs({ t: ['a', 'b', 'c'] }, { t: ['b', 'c'] })
  assert.equal(d.status[pathKey(['t', 0])], 'changed')
  assert.equal(d.status[pathKey(['t', 2])], 'removed')
})

test('diffDocs: an identical document reports nothing at all', () => {
  const doc = { a: 1, b: { c: [1, 2, { d: null }] } }
  const d = diffDocs(doc, structuredClone(doc))
  assert.deepEqual(d.status, {})
  assert.deepEqual(d.count, { added: 0, removed: 0, changed: 0 })
  assert.deepEqual(d.open, [])
})

test('sameValue: JSON values only, and null is not an empty object', () => {
  assert.equal(sameValue({ a: [1, { b: null }] }, { a: [1, { b: null }] }), true)
  assert.equal(sameValue(null, {}), false)
  assert.equal(sameValue([1, 2], [2, 1]), false)
  assert.equal(sameValue({ a: 1 }, { a: 1, b: undefined }), false, 'an extra key is a difference')
})

// ─── convertTo ────────────────────────────────────────────────────────

test('convertTo: a leaf can become a container, which coerceLike will never do', () => {
  // The hole this closes: `coerceLike` keeps the type it replaces, so typing
  // {} into a string field gave the STRING "{}" and a document could be edited
  // but never reshaped.
  assert.deepEqual(convertTo('x', 'object'), {})
  assert.deepEqual(convertTo('x', 'array'), ['x'], 'a leaf wraps, because there is a value to keep')
  assert.deepEqual(convertTo(null, 'array'), [], 'and null has none')
})

test('convertTo: object ⇄ array round-trips through index keys', () => {
  assert.deepEqual(convertTo({ a: 1, b: 2 }, 'array'), [1, 2])
  assert.deepEqual(convertTo([1, 2], 'object'), { 0: 1, 1: 2 })
  assert.deepEqual(convertTo(convertTo([1, 2], 'object'), 'array'), [1, 2])
})

test('convertTo: a string that PARSES as the kind asked for becomes the value', () => {
  // Paste a document into a text field, say `object`, get the document.
  assert.deepEqual(convertTo('{"a":1}', 'object'), { a: 1 })
  assert.deepEqual(convertTo('[1,2]', 'array'), [1, 2])
  assert.deepEqual(convertTo('not json', 'object'), {}, 'and one that does not parse is simply empty')
})

test('convertTo: "false" is false, because that is what a person typing it means', () => {
  // Raw truthiness gets this exactly backwards — every non-empty string is
  // true in JavaScript, including the word false.
  assert.equal(convertTo('false', 'boolean'), false)
  assert.equal(convertTo('0', 'boolean'), false)
  assert.equal(convertTo('', 'boolean'), false)
  assert.equal(convertTo('yes', 'boolean'), true)
  assert.equal(convertTo(0, 'boolean'), false)
  assert.equal(convertTo({}, 'boolean'), false, 'an empty container is empty')
  assert.equal(convertTo({ a: 1 }, 'boolean'), true)
})

test('convertTo: a number that cannot be read is 0, not NaN', () => {
  // NaN is not a JSON value — writing one produces a document that cannot be
  // serialised, from a control that looked like it worked.
  assert.equal(convertTo('abc', 'number'), 0)
  assert.equal(convertTo('  7 ', 'number'), 7)
  assert.equal(convertTo(true, 'number'), 1)
  assert.equal(convertTo(null, 'number'), 0)
})

test('convertTo: a container becomes its own JSON text, not [object Object]', () => {
  assert.equal(convertTo({ a: 1 }, 'string'), '{"a":1}')
  assert.equal(convertTo(null, 'string'), '')
  assert.equal(convertTo(7, 'string'), '7')
})

test('convertTo: asking for the kind it already is answers the SAME value', () => {
  // Identity, not a copy: a no-op conversion that returned a new object would
  // announce a change the document did not make, and in a reactive tree that
  // is a re-render and a history entry for nothing.
  const doc = { a: 1 }
  assert.equal(convertTo(doc, 'object'), doc)
})

// ─── searchDoc · markRuns ─────────────────────────────────────────────

test('searchDoc: a match four levels down answers the rows that must be OPEN', () => {
  // Without this the filter finds everything and shows nothing: `treeRows`
  // only emits children of an open container, so a deep hit is not a row.
  const d = searchDoc({ a: { b: { c: { needle: 1 } } } }, 'needle')
  assert.deepEqual(d.open.sort(),
    [pathKey(['a']), pathKey(['a', 'b']), pathKey(['a', 'b', 'c'])].sort())
  assert.equal(d.count, 1, 'the ancestors are kept to reach it, and are not hits')
})

test('searchDoc: a container whose KEY matches keeps its whole subtree', () => {
  // "find me tags" means the items too, not the word on its own.
  const d = searchDoc({ tags: ['a', 'b'], other: 1 }, 'tags')
  assert.deepEqual(d.keep.sort(),
    [pathKey(['tags']), pathKey(['tags', 0]), pathKey(['tags', 1])].sort())
})

test('searchDoc: a value is matched as the TEXT a reader sees', () => {
  // Otherwise `null` is unfindable by the word on screen, and a number by its
  // digits — which is what a person types.
  assert.equal(searchDoc({ a: null }, 'null').count, 1)
  assert.equal(searchDoc({ a: 1234 }, '23').count, 1)
  assert.equal(searchDoc({ a: true }, 'tru').count, 1)
})

test('searchDoc: an empty term is not a search', () => {
  // Not "everything matches" — a blank box means the filter is off, and a
  // filter that keeps every row still hides the ones a closed branch holds.
  const d = searchDoc({ a: 1 }, '   ')
  assert.equal(d.active, false)
  assert.deepEqual(d.keep, [])
})

test('searchDoc: a term nothing holds keeps nothing at all', () => {
  const d = searchDoc({ a: 1, b: { c: 2 } }, 'zzz')
  assert.equal(d.active, true)
  assert.deepEqual(d.keep, [])
  assert.equal(d.count, 0)
})

test('markRuns: EVERY occurrence, and the original casing', () => {
  // One occurrence marked and the next not says *this is the one*, which is a
  // claim a highlighter cannot make.
  const runs = markRuns('aXbXc', 'x')
  assert.equal(runs.filter(r => r.hit).length, 2)
  assert.equal(runs.map(r => r.text).join(''), 'aXbXc', 'and marking never rewrites the text')
  assert.equal(runs.find(r => r.hit).text, 'X', 'the hit keeps the document’s casing, not the query’s')
})

test('markRuns: no term is one run, not zero', () => {
  assert.deepEqual(markRuns('abc', ''), [{ i: 0, text: 'abc', hit: false }])
  assert.deepEqual(markRuns('', 'x'), [{ i: 0, text: '', hit: false }])
})

// ─── accessorPath · jsonPointer ───────────────────────────────────────

test('accessorPath: a key that is not an identifier is bracketed, not dotted', () => {
  // The point of the function. `a.content-type` parses as a subtraction, and
  // `a.0` is a syntax error — both look right and neither runs.
  assert.equal(accessorPath(['a', 'b', 0]), 'a.b[0]')
  assert.equal(accessorPath(['headers', 'content-type']), 'headers["content-type"]')
  assert.equal(accessorPath(['a', '0']), 'a["0"]', 'a string key that looks like an index stays a key')
  assert.equal(accessorPath([0, 'x']), '[0].x', 'a document whose root is an array')
})

test('accessorPath: a root is prefixed, and without one the first key has no dot', () => {
  assert.equal(accessorPath(['a', 'b'], 'data'), 'data.a.b')
  assert.equal(accessorPath(['a', 'b']), 'a.b')
  assert.equal(accessorPath([], 'data'), 'data')
})

test('jsonPointer: ~ and / are escaped, which is why it is not a join', () => {
  // A key containing a slash is otherwise two segments, and the pointer names
  // a member that does not exist.
  assert.equal(jsonPointer(['a', 'b', 0]), '/a/b/0')
  assert.equal(jsonPointer(['a/b']), '/a~1b')
  assert.equal(jsonPointer(['a~b']), '/a~0b')
  assert.equal(jsonPointer(['~/']), '/~0~1', 'both, in the order the spec states')
  assert.equal(jsonPointer([]), '', 'the whole document is the empty pointer')
})
