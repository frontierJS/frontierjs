// web/test/emoji.test.js — emoji and wide characters in what is said (14.3):
// a single emoji, a CJK pair, a skin tone, a ZWJ sequence and a flag, each
// counted in the cells a screen gives it. The browser's count agrees with the
// terminal's; a bubble near the right edge stays inside the view; a booth's
// bubble is one width on every row and theirs ends on the column's edge; a
// history row is cut on a grapheme. Then the real `Bubbles.mesa` drawn over
// the square in OpenTUI's headless renderer (`said-frame.mjs`, a child): the
// bubble covers exactly its cells and every cell of art beside it is the art.
//
// The input line is mesa's (`test/terminal/specs/wide.spec.mjs`); both
// targets together are `verify-emoji.mjs`.
import { test, expect, describe } from 'bun:test'
import { join } from 'node:path'

import { cells, clip, estimate } from '../src/cells.js'
import { bubbles } from '../src/crowd.js'
import { bubble, transcript, wrap, COLUMN } from '../src/booth.js'

const SAID = ['🙂', '中文', '👍🏽', '👩‍💻', '🇯🇵']
const OTHERS = ['❤️', '❤', 'é', '1️⃣', '🏳️‍🌈', '👨‍👩‍👧‍👦', '한국', 'Ａ', '✓', '━', '·', '​']
const graphemes = (s) => [...new Intl.Segmenter().segment(s)].map((g) => g.segment)

describe('cells', () => {
  test('each said grapheme is two cells, and a browser counts what the terminal counts', () => {
    for (const g of SAID.flatMap(graphemes)) expect([g, cells(g)]).toEqual([g, 2])
    for (const s of [...SAID, ...OTHERS, `hi ${SAID.join(' ')}!`]) expect([s, estimate(s)]).toEqual([s, Bun.stringWidth(s)])
  })

  test('clip never cuts a grapheme, and never past the width', () => {
    expect(clip('a👩‍💻b', 2)).toBe('a')
    expect(clip('a👩‍💻b', 3)).toBe('a👩‍💻')
    expect(clip('中文中', 5)).toBe('中文')
    expect(clip('🇯🇵🇯🇵', 3)).toBe('🇯🇵')
    for (const s of SAID) for (let n = 0; n < 6; n++) {
      const c = clip(`x${s}${s}`, n)
      expect(cells(c)).toBeLessThanOrEqual(n)
      expect(`x${s}${s}`.startsWith(c) && graphemes(c).every((g, i) => g === graphemes(`x${s}${s}`)[i])).toBe(true)
    }
  })
})

describe('a bubble over a figure', () => {
  const spawn = { x: 5, y: 5 }
  const view = { x: 0, y: 0, w: 40, h: 12 }
  const here = { self: { userId: 1 }, others: [{ userId: 2, connectionId: 'c2', meta: { x: 38, y: 6 } }] }

  test('is kept inside the view by its cells, not its UTF-16 length', () => {
    for (const body of ['中文中文中文', '👩‍💻👩‍💻 ok', '🇯🇵🇯🇵🇯🇵']) {
      const [b] = bubbles(here, [{ id: 1, memberId: 2, body }], 30, 6, view, spawn)
      expect([body, b.x + cells(b.rows[0])]).toEqual([body, view.w])
    }
  })
})

describe('a booth', () => {
  test('a bubble is one width on every row, counted in cells', () => {
    const rows = bubble('中文 🙂 👍🏽 ok 👩‍💻 🇯🇵 中文中文 done', 14)
    expect(rows.length).toBeGreaterThan(1)
    expect(new Set(rows.map(cells)).size).toBe(1)
    expect(Math.max(...rows.map(cells))).toBeLessThanOrEqual(14)
  })

  test('a word of wide graphemes longer than a row is cut between graphemes', () => {
    const rows = wrap('中文中文中文中文 👩‍💻👩‍💻👩‍💻👩‍💻', 5)
    expect(rows).toEqual(['中文', '中文', '中文', '中文', '👩‍💻👩‍💻', '👩‍💻👩‍💻'])
    expect(wrap('中', 1)).toEqual(['中'])
  })

  test('theirs ends on the right edge of the column, mine starts on the left', () => {
    const said = [{ id: 2, memberId: 2, roomId: 7, body: '中文 中文' }, { id: 1, memberId: 1, roomId: 7, body: '👩‍💻 🙂' }]
    const [mine, theirs] = transcript(said, { me: 1, roomId: 7 })
    expect(mine.x).toBe(0)
    expect(theirs.x + cells(theirs.text)).toBe(COLUMN.w)
  })
})

describe('drawn in the terminal', () => {
  const bodies = [
    ...SAID.map((s) => ({ body: `hi ${s} there`, dx: 6, dy: -4 })),
    { body: '中文中文中文', dx: 5, dy: -4, me: { x: 88, y: 21 } },
  ]
  const run = Bun.spawnSync(['bun', join(import.meta.dir, 'said-frame.mjs'), JSON.stringify(bodies)], { cwd: join(import.meta.dir, '../..'), stderr: 'pipe' })
  const rows = run.stdout.toString().trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))

  test('every line was drawn', () => {
    expect([rows.length, run.stderr.toString().replace(/.*not ready.*\n/g, '')]).toEqual([bodies.length, ''])
  })

  for (const [i, { body }] of bodies.entries()) {
    test(`${JSON.stringify(body)}: the bubble takes its cells and the art beside it is the art`, () => {
      const { before, after, w } = rows[i]
      const want = graphemes(`(${body})`).flatMap((g) => [g, ...Array(cells(g) - 1).fill('')])
      const at = after.findIndex((_, x) => want.every((c, k) => after[x + k] === c))
      expect(at).toBeGreaterThanOrEqual(0)
      expect(after.length).toBe(before.length)
      for (let x = 0; x < after.length; x++) {
        if (x >= at && x < at + want.length) continue
        expect([x, after[x]]).toEqual([x, before[x]])
      }
      expect(at + want.length).toBeLessThanOrEqual(w)
    })
  }
})
