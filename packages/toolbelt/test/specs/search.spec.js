/*
 * search.spec.js
 *
 * Two things are under test and only one of them is the algorithm.
 *
 * The scoring comes from an adopted implementation and is exercised here only
 * enough to prove it is wired and ordering the way a picker needs. What is
 * genuinely ours — and what the copies this kit replaces each got wrong — is
 * the SHAPE of the answer: ranges rather than markup, ranges beside the item
 * rather than written onto it, and a rendering primitive that cannot inject.
 * Those are the cases that would catch a rewrite going wrong.
 */

import { score, rank, mergeRanges, segments } from '../../src/search/search.js'

/* ── score ─────────────────────────────────────────────────────────── */

test('search: a match scores above zero and says where it landed', function () {
  const { score: s, ranges } = score('Ada Lovelace', 'lov')

  assert.ok(s > 0, 'scored')
  assert.equal(ranges.length, 1)
  assert.equal('Ada Lovelace'.slice(ranges[0][0], ranges[0][1]).toLowerCase(), 'lov')
})

test('search: no match scores zero with no ranges', function () {
  const { score: s, ranges } = score('Ada Lovelace', 'zzz')
  assert.equal(s, 0)
  assert.equal(ranges.length, 0)
})

test('search: a null or empty text is answered, not thrown at', function () {
  // The algorithm lowercases both arguments by default, so an absent value
  // reaches it as a TypeError from inside a library rather than an answer.
  assert.equal(score(null, 'a').score, 0)
  assert.equal(score('', 'a').score, 0)
  assert.equal(score('Ada', null).ranges.length, 0)
})

test('search: a prefix match outranks one in the middle', function () {
  assert.ok(score('lovelace', 'lov').score > score('Ada Lovelace', 'lov').score)
})

/* ── rank ──────────────────────────────────────────────────────────── */

test('search: ranks strings best first', function () {
  const out = rank(['Grace Hopper', 'Ada Lovelace', 'Lovelace Inc'], 'lovelace')

  assert.ok(out.length >= 2)
  assert.equal(out[0].item, 'Lovelace Inc')     // starts with it
  assert.equal(out[0].key, null)                 // plain strings have no key
  assert.ok(Array.isArray(out[0].ranges))
})

test('search: an empty query answers every item', function () {
  // A picker opening with nothing typed shows its whole list — the alternative
  // is a dropdown that is blank until you type, which reads as broken.
  assert.equal(rank(['a', 'b', 'c'], '').length, 3)
})

test('search: keys name what to score, and the winning key comes back', function () {
  const rows = [
    { id: 1, name: 'Ada Lovelace',  email: 'ada@example.com' },
    { id: 2, name: 'Grace Hopper',  email: 'grace@lovelace.org' },
  ]
  const out = rank(rows, 'lovelace', { keys: ['name', 'email'] })

  assert.equal(out.length, 2)
  // `key` is the field that scored best and `ranges` are ITS ranges, so a
  // caller highlighting one label needs no second lookup.
  const ada = out.find((r) => r.item.id === 1)
  assert.equal(ada.key, 'name')
  assert.ok(ada.ranges.length > 0)
  // …and the whole map is there for a row that renders several fields.
  assert.ok(ada.byKey && 'email' in ada.byKey)
})

test('search: never writes to the item it ranked', function () {
  // The implementation this replaces did `r.item._highlight = r.matches`, so
  // one object in two lists carried the last search's ranges and a cleared
  // query left them behind.
  const row  = { name: 'Ada Lovelace' }
  const before = Object.keys(row).length

  rank([row], 'ada', { keys: ['name'] })

  assert.equal(Object.keys(row).length, before, 'no key was added')
  assert.equal(row._highlight, undefined)
})

test('search: limit trims after ranking, not before', function () {
  const out = rank(['Lovelace Inc', 'Ada Lovelace', 'Grace Hopper'], 'lovelace', { limit: 1 })
  assert.equal(out.length, 1)
  assert.equal(out[0].item, 'Lovelace Inc')
})

test('search: an empty list is answered, not iterated', function () {
  assert.equal(rank([], 'x').length, 0)
  assert.equal(rank(null, 'x').length, 0)
})

/* ── mergeRanges ───────────────────────────────────────────────────── */

test('search: overlapping and touching ranges merge into one run', function () {
  assert.deepEqual(mergeRanges([[0, 3]], [[2, 5]]), [[0, 5]])
  // Touching, not overlapping: two adjacent runs of matched characters are one
  // run, and rendering them apart puts a seam inside a highlight.
  assert.deepEqual(mergeRanges([[0, 3]], [[3, 5]]), [[0, 5]])
  assert.deepEqual(mergeRanges([[0, 2]], [[4, 6]]), [[0, 2], [4, 6]])
})

test('search: merge sorts, and either side may be absent', function () {
  assert.deepEqual(mergeRanges([[4, 6], [0, 2]]), [[0, 2], [4, 6]])
  assert.deepEqual(mergeRanges(), [])
  assert.deepEqual(mergeRanges([[1, 2]]), [[1, 2]])
})

/* ── segments ──────────────────────────────────────────────────────── */

test('search: segments alternate, and carry no markup', function () {
  const parts = segments('Ada Lovelace', [[4, 8]])

  assert.deepEqual(parts, [
    { text: 'Ada ',     match: false },
    { text: 'Love',     match: true  },
    { text: 'lace',     match: false },
  ])
  // The point of the whole shape: a caller cannot be handed a string that
  // renders as HTML, so a label out of a database row cannot inject.
  parts.forEach(function (p) {
    assert.equal(typeof p.text, 'string')
    assert.equal(p.text.includes('<mark'), false)
  })
})

test('search: a match at index 0 does not lead with an empty piece', function () {
  assert.deepEqual(segments('Ada', [[0, 3]]), [{ text: 'Ada', match: true }])
})

test('search: markup in the source text stays text', function () {
  // The case this kit exists to make unrepresentable.
  const evil = '<img src=x onerror=alert(1)>'
  const parts = segments(evil, [[0, 3]])

  assert.equal(parts.map((p) => p.text).join(''), evil)
  assert.equal(parts[0].match, true)
})

test('search: no ranges is one unmatched piece; no text is nothing', function () {
  assert.deepEqual(segments('Ada'), [{ text: 'Ada', match: false }])
  assert.deepEqual(segments(''), [])
  assert.deepEqual(segments(null), [])
})

test('search: a range past the end is clamped rather than throwing', function () {
  // Ranges may have been computed against a different transformation of the
  // string. A silent '' would hide that; a throw would take the list down.
  assert.deepEqual(segments('Ada', [[1, 99]]), [
    { text: 'A',  match: false },
    { text: 'da', match: true  },
  ])
})
