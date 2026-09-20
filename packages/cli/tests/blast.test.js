// The tally itself. `git-status.test.js` covers what the listing does with a
// reading; this covers whether the reading is one — and the one thing it must
// never do is answer 0 where it means "I could not look".

import { test, expect } from 'bun:test'
import { blastReader } from '../core/blast.js'

test('a candidate nobody names reads 0, a non-candidate reads null', () => {
  const read = blastReader({ usedBy: new Map([['a/hub.js', 20]]), code: new Set(['a/hub.js', 'a/lonely.js']) })
  expect(read('a/hub.js')).toEqual({ usedBy: 20, band: 3 })
  expect(read('a/lonely.js')).toEqual({ usedBy: 0, band: 0 })
  // Not code, or not tracked. The listing renders this as no mark at all, and
  // it must not be reachable by a file that simply has no importers.
  expect(read('a/README.md')).toBe(null)
})

test('the bands are codegraph BLAST and nothing restates them', async () => {
  // A copy of [0, 3, 15] here would drift from the page that draws the same
  // file as a hub, which is the whole reason the reader is shared.
  const { BLAST } = await import('../core/codegraph.js')
  expect(BLAST).toEqual([0, 3, 15])
  const read = blastReader({ usedBy: new Map(), code: new Set(['x']) })
  const at = n => blastReader({ usedBy: new Map([['x', n]]), code: new Set(['x']) })('x').band
  expect(read('x').band).toBe(0)
  expect([at(1), at(3)]).toEqual([1, 1])
  expect([at(4), at(15)]).toEqual([2, 2])
  expect(at(16)).toBe(3)
})

test('an unreadable tree answers empty rather than throwing', async () => {
  // A blast mark annotates a listing. A listing that refuses to print because
  // a git call failed is worse than one printing no marks.
  const { usedByIndex } = await import('../core/blast.js')
  const idx = usedByIndex('/nonexistent-path-for-this-test')
  expect(idx.usedBy.size).toBe(0)
  expect(idx.code.size).toBe(0)
  expect(blastReader(idx)('anything')).toBe(null)
})
