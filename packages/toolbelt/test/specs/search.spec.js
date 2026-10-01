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

/* ── rank, by words ────────────────────────────────────────────────── */

const SITES = [
  { name: 'GitHub Issues', url: 'https://github.com/issues' },
  { name: 'Hacker News',   url: 'https://news.ycombinator.com' },
  { name: 'Rust std docs', url: 'https://doc.rust-lang.org/std' },
]

test('search: words match in any order, which one query read in order does not', function () {
  // The query read as one run of letters needs them in order, so a person who
  // types the words the other way round finds nothing.
  assert.equal(rank(SITES, 'issues github', { keys: ['name'] }).length, 0)

  const out = rank(SITES, 'issues github', { keys: ['name'], words: true })
  assert.equal(out.length, 1)
  assert.equal(out[0].item.name, 'GitHub Issues')
})

test('search: every word must match, each in whichever field it can', function () {
  // `rust` lands in the name and `lang` only in the address: one row.
  const out = rank(SITES, 'lang rust', { keys: ['name', 'url'], words: true })
  assert.equal(out.length, 1)
  assert.equal(out[0].item.name, 'Rust std docs')
  assert.ok(out[0].byKey.name.length > 0 && out[0].byKey.url.length > 0, 'each field marks its own word')

  assert.equal(rank(SITES, 'rust zzz', { keys: ['name', 'url'], words: true }).length, 0)
})

test('search: with words, each word must clear the minimum on its own', function () {
  // `hn` finds Hacker News and, thinly, two addresses that hold an h then an n.
  const loose = rank(SITES, 'hn', { keys: ['name', 'url'], words: true })
  assert.ok(loose.length > 1)
  const tight = rank(SITES, 'hn', { keys: ['name', 'url'], words: true, minimumScore: 0.2 })
  assert.deepEqual(tight.map((r) => r.item.name), ['Hacker News'])
})

test('search: a word marks only the fields where it cleared the minimum', function () {
  // `hn` scores 0.1 against this address: an h, then an n much later.
  const rows = [{ name: 'Hacker News', url: 'https://doc.rust-lang.org/std' }]
  assert.ok(score(rows[0].url, 'hn').score < 0.2)
  const [hn] = rank(rows, 'hn', { keys: ['name', 'url'], words: true, minimumScore: 0.2 })
  assert.equal(hn.key, 'name')
  assert.deepEqual(segments(hn.item.name, hn.ranges).filter((p) => p.match).map((p) => p.text), ['H', 'N'])
  assert.equal(hn.byKey.url, undefined)
})

test('search: the whole query in order still ranks a name typed out first', function () {
  const rows = [{ name: 'News Hacker Digest' }, { name: 'Hacker News' }]
  const out = rank(rows, 'hacker news', { keys: ['name'], words: true })
  assert.equal(out[0].item.name, 'Hacker News')
})

test('search: one word with words on scores as the plain path does', function () {
  const plain = rank(SITES, 'rust', { keys: ['name', 'url'] })
  const byWord = rank(SITES, 'rust', { keys: ['name', 'url'], words: true })
  assert.deepEqual(byWord.map((r) => [r.item.name, r.score, r.key]), plain.map((r) => [r.item.name, r.score, r.key]))
})

test('search: words over plain strings answer flat ranges and no key', function () {
  const out = rank(['Grace Hopper', 'Ada Lovelace'], 'love ada', { words: true })
  assert.equal(out.length, 1)
  assert.equal(out[0].key, null)
  assert.equal(out[0].byKey, undefined)
  assert.ok(out[0].ranges.length >= 2)
})

test('search: an empty query with words answers every item, as the plain path does', function () {
  assert.deepEqual(rank(['b', 'a'], '  ', { words: true }), rank(['b', 'a'], '  '))
})

/* ── rank, weighted ────────────────────────────────────────────────── */

test('search: a weight scales one field, so a name outranks an address', function () {
  const rows = [
    { name: 'Some page',  url: 'https://example.com/fresh' },
    { name: 'FreshBooks', url: 'https://freshbooks.com' },
  ]
  const out = rank(rows, 'fresh', { keys: ['name', 'url'], weights: { url: 0.5 } })
  assert.equal(out[0].item.name, 'FreshBooks')
  const page = out.find((r) => r.item.name === 'Some page')
  assert.equal(page.key, 'url')
  assert.ok(page.score <= 0.5, 'the address scored at most half')
})

test('search: a nested key is weighted by its dotted name', function () {
  const rows = [{ who: { name: 'Ada' }, note: 'ada' }]
  const [r] = rank(rows, 'ada', { keys: [['who', 'name'], 'note'], weights: { 'who.name': 0.1 } })
  assert.equal(r.key, 'note')
  assert.ok(r.byKey['who.name'].length > 0)
})

test('search: ties sort by the first key, case-insensitively', function () {
  const rows = [{ name: 'beta x' }, { name: 'Alfa x' }]
  const out = rank(rows, 'x', { keys: ['name'], words: true })
  assert.equal(out[0].score, out[1].score)
  assert.deepEqual(out.map((r) => r.item.name), ['Alfa x', 'beta x'])
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
