// test/booth.test.js — the booth's column laid out: a bubble stays, a new one
// goes under it, mine against the left and theirs against the right, and a
// full column scrolls off its top. And the table's seats on a real stage.

import { test, expect, describe } from 'bun:test'

import { wrap, bubble, transcript, COLUMN } from '../src/lib/games/booth.js'
import { createStage, arrival } from '../src/lib/scene/stage.js'
import { table } from '../src/pieces/table.js'
import { candle } from '../src/pieces/candle.js'
import { leftFace, rightFace, LIT } from '../src/pieces/face.js'

const line = (id, memberId, body, roomId = 7) => ({ id, memberId, roomId, body })

describe('wrap', () => {
  test('breaks at spaces and never past the width', () => {
    expect(wrap('the quick brown fox', 10)).toEqual(['the quick', 'brown fox'])
    expect(wrap('  spaced   out  ', 20)).toEqual(['spaced out'])
  })

  test('cuts a word longer than a row', () => {
    expect(wrap('abcdefghij kl', 4)).toEqual(['abcd', 'efgh', 'ij', 'kl'])
  })
})

describe('bubble', () => {
  test('is one box, the same width on every row', () => {
    expect(bubble('hi')).toEqual(['( hi )'])
    expect(bubble('one two three', 12)).toEqual(['( one two  ', '  three   )'])
  })

  test('closes on its last row only', () => {
    const rows = bubble('aaa bbb ccc', 9)
    expect(rows.length).toBe(3)
    expect(rows.map((r) => r.length)).toEqual([rows[0].length, rows[0].length, rows[0].length])
    expect(rows[0].startsWith('( ')).toBe(true)
    expect(rows.slice(0, -1).some((r) => r.endsWith(')'))).toBe(false)
    expect(rows.at(-1).endsWith(' )')).toBe(true)
  })
})

describe('transcript', () => {
  const me = 1
  const said = [line(3, 1, 'and you?'), line(2, 2, 'fine, thanks'), line(1, 1, 'how are you')]

  test('appends downward, oldest at the top', () => {
    const rows = transcript(said, { me, roomId: 7 })
    expect(rows.map((r) => r.text.trim())).toEqual(['( how are you )', '( fine, thanks )', '( and you? )'])
    expect(rows.map((r) => r.y)).toEqual([0, 1, 2])
  })

  test('puts mine against the left edge and theirs against the right', () => {
    const rows = transcript(said, { me, roomId: 7 })
    expect(rows[0].x).toBe(0)
    expect(rows[1].x + rows[1].text.length).toBe(COLUMN.w)
    expect(rows[2].x).toBe(0)
  })

  test('keeps a bubble whole across rows, and its rows together', () => {
    const rows = transcript([line(1, 2, 'a '.repeat(60))], { me, roomId: 7 })
    expect(rows.length).toBeGreaterThan(1)
    expect(new Set(rows.map((r) => r.key.split(':')[0]))).toEqual(new Set(['1']))
    expect(new Set(rows.map((r) => r.text.length)).size).toBe(1)
  })

  test('scrolls the oldest off the top when the column is full', () => {
    const many = Array.from({ length: 30 }, (_, i) => line(30 - i, 2, `line ${30 - i}`))
    const rows = transcript(many, { me, roomId: 7, height: 24 })
    expect(rows.length).toBe(24)
    expect(rows[0].text).toContain('line 7')
    expect(rows.at(-1).text).toContain('line 30')
  })

  test('shows only this booth\'s lines', () => {
    const rows = transcript([line(2, 2, 'elsewhere', 8), line(1, 2, 'here')], { me, roomId: 7 })
    expect(rows.map((r) => r.text.trim())).toEqual(['( here )'])
  })
})

describe('the table\'s seats', () => {
  const sit = () => {
    const stage = createStage({ slug: 'seats-test', spawn: { x: 0, y: 0 } })
    stage.stamp(table, 10, 5)
    return stage
  }

  test('a stool is walked onto, and the table is not', () => {
    const stage = sit()
    expect(stage.walkable(10, 6)).toBe(true)
    expect(stage.walkable(20, 6)).toBe(true)
    expect(stage.walkable(11, 6)).toBe(false)
  })

  test('each stool names the one across and where to stand up', () => {
    const stage = sit()
    expect(stage.seatAt(10, 6)).toEqual({ mate: { x: 20, y: 6 }, stand: { x: 9, y: 6 } })
    expect(stage.seatAt(20, 6)).toEqual({ mate: { x: 10, y: 6 }, stand: { x: 21, y: 6 } })
    expect(stage.seatAt(9, 6)).toBeNull()
    expect(stage.seatAt(15, 6)).toBeNull()
  })

  test('the candle burns only while a stool is taken, and is a white dot otherwise', () => {
    const stage = createStage({ slug: 'candle-test', palette: { y: { fg: ['#fde047', '#fbbf24'], chars: 'i!', ms: 300, flicker: true } }, spawn: { x: 0, y: 0 } })
    stage.stamp(table, 10, 5)
    const wick = (ms) => stage.look(15, 6, ms)
    const glyphs = (ms) => new Set(Array.from({ length: 40 }, (_, i) => wick(i * 300 + ms).ch))
    expect(glyphs(0)).toEqual(new Set(['.']))
    expect(wick(0).fg).toBe('#ffffff')
    stage.occupy([{ x: 10, y: 6 }])
    expect(glyphs(0).has('!')).toBe(true)
    expect(wick(0).fg).not.toBe('#ffffff')
    stage.occupy([{ x: 20, y: 6 }])
    expect(glyphs(0).has('!')).toBe(true)
    stage.occupy([{ x: 11, y: 6 }])
    expect(glyphs(0)).toEqual(new Set(['.']))
  })

  test('a seat moves with its table', () => {
    const stage = sit()
    stage.marks[0].move(12, 8)
    expect(stage.seatAt(10, 6)).toBeNull()
    expect(stage.seatAt(12, 9)).toMatchObject({ stand: { x: 11, y: 9 } })
  })

  test('standing up from a booth is where the booth says, and a stool is never it', () => {
    const stage = sit()
    const out = stage.seatAt(10, 6).stand
    expect(stage.walkable(out.x, out.y)).toBe(true)
    expect(stage.seatAt(out.x, out.y)).toBeNull()
    expect(arrival(stage, { from: '/booth/', x: String(out.x), y: String(out.y), stand: 1 })).toEqual(out)
  })
})

describe('the booth\'s light', () => {
  test('a head is lit on the side facing the table, and the mirror on the mirrored side', () => {
    const lit = { rim: 'R', mid: 'D' }
    const sides = [[leftFace('m', lit), 'm', (xs) => Math.max(...xs)], [rightFace('t', lit), 't', (xs) => Math.min(...xs)]]
    for (const [face, key, inner] of sides) {
      for (const cells of Map.groupBy(face.cells, (c) => c.dy).values()) {
        const edge = inner(cells.map((c) => c.dx))
        for (const c of cells) {
          const d = Math.abs(c.dx - edge)
          expect(c.key).toBe(d < LIT.rim ? 'R' : d < LIT.mid ? 'D' : key)
        }
      }
    }
  })

  test('unlit, a head is its own color throughout', () => {
    expect(new Set(leftFace('m').cells.map((c) => c.key))).toEqual(new Set(['m']))
  })

  test('the candle\'s tip is three cells, one per lean, over the wick', () => {
    const tip = candle.cells.filter((c) => c.dy === 0).map((c) => c.key)
    const wick = candle.cells.find((c) => c.key === 'k')
    expect(tip).toEqual(['l', 'i', 'j'])
    expect(candle.cells.find((c) => c.key === 'i').dx).toBe(wick.dx)
  })
})
