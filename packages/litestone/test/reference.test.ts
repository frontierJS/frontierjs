// test/reference.test.ts
//
// `docs/reference.snapshot.md` is the language read as a page rather than as a
// table. The `snapshots` CI phase already stops it going STALE — it reruns the
// generator and byte-compares — so what is left for a test is the class a byte
// comparison cannot see: a page that regenerates perfectly and is wrong.
//
// Three of those, and each one has already happened somewhere in this repo.
//
//   an entry goes missing      the whole point is that you can look any word up,
//                              and a renderer that skipped a group would still
//                              round-trip its own output forever
//
//   a link points nowhere      the index is 179 links into 89 anchors, and a
//                              markdown anchor is derived from rendered heading
//                              text, which two different words here reduce to
//                              the same value of
//
//   prose loses a word         a blurb says `<Form>`, markdown reads it as an
//                              unknown HTML tag and renders NOTHING. The sentence
//                              still looks like a sentence
//
// None of the three is visible in a diff of the generated file, which is what
// makes them worth a test rather than a review.

import { describe, test, expect } from 'bun:test'
import { renderCatalogReference } from '../src/tools/catalog-reference.js'
import { CATALOG, typed, probeFor } from '../src/core/catalog.js'
import { RULES } from '../src/core/advise.js'

const PAGE = renderCatalogReference()

/**
 * Everything the renderer had to escape by hand: fenced blocks and code spans
 * are literal already, and an arity is deliberately put inside a span for that
 * reason.
 */
const PROSE = PAGE.replace(/```lite[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')

const anchors = new Set([...PAGE.matchAll(/<a id="([^"]+)"><\/a>/g)].map(m => m[1]))

describe('every word has an entry', () => {
  for (const row of CATALOG) {
    test(`${typed(row)}`, () => {
      // The heading, not just a mention: a word named only in someone else's
      // "see also" is exactly the state the other docs were already in.
      const heading = new RegExp(`^#{3,4} \`${typed(row).replace(/[@]/g, '@')}\``, 'm')
      expect({ word: typed(row), heading: heading.test(PAGE) })
        .toEqual({ word: typed(row), heading: true })

      // …and the example, which is the catalog's own probe rather than a second
      // assembly of it. This is what makes "every sample here is parsed by the
      // suite" true rather than intended.
      expect(PAGE).toContain(probeFor(row))
    })
  }

  test('the index links every word', () => {
    for (const row of CATALOG)
      expect({ word: typed(row), listed: PAGE.includes(`\`](#${anchorFor(row)})`) })
        .toEqual({ word: typed(row), listed: true })
  })

  test('every rule is written out', () => {
    for (const rule of RULES) {
      expect(PAGE).toContain(rule.id)
      expect(PAGE).toContain(rule.blurb)
    }
  })
})

/** The renderer's rule, restated — the assertions below are about agreement with it. */
const anchorFor = (row: any) =>
  `${row.word.toLowerCase()}-${row.level === 'schema' ? 'declaration' : row.level}`

describe('the page renders as it reads', () => {
  test('no link points at an anchor that is not there', () => {
    const links = [...PAGE.matchAll(/\]\(#([^)]+)\)/g)].map(m => m[1])
    expect(links.length).toBeGreaterThan(100)
    expect([...new Set(links.filter(l => !anchors.has(l)))]).toEqual([])
  })

  test('no anchor is claimed twice', () => {
    const all = [...PAGE.matchAll(/<a id="([^"]+)"><\/a>/g)].map(m => m[1])
    const twice = all.filter((a, i) => all.indexOf(a) !== i)
    expect(twice).toEqual([])
    // The pair the explicit anchors exist for: `type` and `@type` are different
    // words that reduce to one slug.
    expect(anchors.has('type-declaration')).toBe(true)
    expect(anchors.has('type-field')).toBe(true)
  })

  test('prose carrying an angle bracket keeps its word', () => {
    // Three blurbs say <Form>, <claim> and <Model>. Raw, markdown renders them
    // as nothing and the sentence quietly loses a noun.
    const raw = PROSE.match(/<(?!\/?a\b)[A-Za-z][^\s>]*>/g) ?? []
    expect(raw).toEqual([])
    expect(PAGE).toContain('&lt;Form&gt;')
  })

  test('every table row has the width its header declared', () => {
    // An unescaped `|` inside a cell splits it, and every column after it moves
    // one to the left — a table that still renders, saying something else.
    let width: number | null = null
    let tables = 0
    for (const line of PAGE.split('\n')) {
      if (!line.startsWith('|')) { if (width !== null) tables++; width = null; continue }
      const cells = line.split('|').length
      if (width === null) width = cells
      expect({ line, cells, width }).toEqual({ line, cells: width, width })
    }
    expect(tables).toBeGreaterThan(1)
  })
})

describe('the generator is deterministic', () => {
  test('two renders agree', () => {
    // The snapshot phase compares bytes, so anything unordered here fails CI on
    // an unrelated branch rather than on the one that introduced it.
    expect(renderCatalogReference()).toBe(PAGE)
  })
})
