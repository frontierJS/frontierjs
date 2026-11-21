// test/booth.test.js — the booth's column laid out: a bubble stays, a new one
// goes under it, mine against the left and theirs against the right, and a
// full column scrolls off its top. And the table's seats on a real stage.

import { test, expect, describe } from 'bun:test'

import { wrap, bubble, transcript, COLUMN } from '../src/lib/games/booth.js'
import { boardRows, status } from '../src/lib/games/checkers.js'
import { START, applyMove, mustCapture, parseMove, squareIndex, winnerOf } from '#shared/checkers.ts'
import { MAX_DICE, parseRoll } from '#shared/dice.ts'
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

// A board from `{ c3: 'r' }`, every other square empty.
const put = (pieces) => {
  const b = Array(64).fill('.')
  for (const [sq, c] of Object.entries(pieces)) b[squareIndex(sq)] = c
  return b.join('')
}
const go = (board, side, ...squares) => applyMove(board, side, squares.map(squareIndex))

describe('checkers rules', () => {
  test('a fresh board has twelve a side on the dark squares, red to start', () => {
    expect([...START].filter(c => c === 'r').length).toBe(12)
    expect([...START].filter(c => c === 'b').length).toBe(12)
    expect(START[squareIndex('a1')]).toBe('r')
    expect(START[squareIndex('h8')]).toBe('b')
    expect(go(START, 'r', 'a3', 'b4')[squareIndex('b4')]).toBe('r')
  })

  test('a man steps forward only, onto an empty square, and only its own side moves', () => {
    expect(() => go(START, 'r', 'a3', 'a4')).toThrow()
    expect(() => go(START, 'r', 'a1', 'b2')).toThrow()
    expect(() => go(START, 'r', 'b6', 'a5')).toThrow('not your piece')
    expect(() => go(put({ b4: 'r' }), 'r', 'b4', 'a3')).toThrow()
  })

  test('a capture is compulsory and a chain must go on while it can', () => {
    const board = put({ a1: 'r', b2: 'b', d4: 'b', h8: 'b', c1: 'r' })
    expect(mustCapture(board, 'r')).toBe(true)
    expect(() => go(board, 'r', 'c1', 'd2')).toThrow('must take it')
    expect(() => go(board, 'r', 'a1', 'c3')).toThrow('must keep capturing')
    const after = go(board, 'r', 'a1', 'c3', 'e5')
    expect(after[squareIndex('e5')]).toBe('r')
    expect(after[squareIndex('b2')]).toBe('.')
    expect(after[squareIndex('d4')]).toBe('.')
  })

  test('a man that reaches the far rank is crowned, and a king goes both ways', () => {
    const crowned = go(put({ b6: 'r', c7: 'b', h2: 'b' }), 'r', 'b6', 'd8')
    expect(crowned[squareIndex('d8')]).toBe('R')
    expect(crowned[squareIndex('c7')]).toBe('.')
    expect(go(put({ d4: 'R' }), 'r', 'd4', 'c3')[squareIndex('c3')]).toBe('R')
  })

  test('a side with nothing left to move has lost', () => {
    expect(winnerOf(put({ a1: 'r' }), 'b')).toBe('r')
    expect(winnerOf(START, 'b')).toBeNull()
  })

  test('/move reads squares however they are separated, and nothing else', () => {
    expect(parseMove('c3 d4')).toEqual(['c3', 'd4'].map(squareIndex))
    expect(parseMove('c3-d4')).toEqual(['c3', 'd4'].map(squareIndex))
    expect(parseMove('C3xE5xG7')).toEqual(['c3', 'e5', 'g7'].map(squareIndex))
    for (const bad of ['c3', 'z9 a1', 'c3 d9', 'castle']) expect(parseMove(bad)).toBeNull()
  })
})

describe('the board a member sees', () => {
  test('is drawn from their own side, their pieces o and the other\'s x', () => {
    const game = { board: START, redId: 1, blackId: 2, turn: 'r', winnerId: null, last: null }
    const red = boardRows(game, 'r')
    const black = boardRows(game, 'b')
    expect(red[0]).toBe('  a b c d e f g h')
    expect(red[1].startsWith('8 ')).toBe(true)
    expect(red[1]).toContain('x')
    expect(red[8]).toContain('o')
    expect(black[0]).toBe('  h g f e d c b a')
    expect(black[1].startsWith('1 ')).toBe(true)
    expect(black[1]).toContain('x')
  })

  test('says whose move it is and who won', () => {
    const game = { board: START, redId: 1, blackId: 2, turn: 'r', winnerId: null, last: null }
    const nicks = { 1: 'sam', 2: 'ana' }
    expect(status(null, { me: 1, nicks })).toContain('/checkers begins one')
    expect(status(game, { me: 1, nicks })).toContain('Your move')
    expect(status(game, { me: 2, nicks })).toBe('sam to move')
    expect(status({ ...game, winnerId: 2, last: 'resigned' }, { me: 2, nicks })).toContain('You won')
  })
})

describe('a roll spec', () => {
  test('is count d sides within the limits, and nothing else', () => {
    expect(parseRoll('2d6')).toEqual({ count: 2, sides: 6 })
    expect(parseRoll('d20')).toEqual({ count: 1, sides: 20 })
    for (const bad of ['', '6', '0d6', `${MAX_DICE + 1}d6`, '2d1', '2d101', '2d6 + 1', 'roll']) expect(parseRoll(bad)).toBeNull()
  })
})
