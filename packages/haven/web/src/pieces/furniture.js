// src/pieces/furniture.js — what a room is furnished with: a couch, a cot, a
// jukebox, a bucket, and the rug. A seat faces the way its cushions do.
import { piece, inked, seats } from './index.js'

/** Four cushions facing up the room. */
export const couch = piece('couch', String.raw`
.-[____][____][____][____]-.
'--------------------------'
`, String.raw`
LLlllllllllllllllllllllllLLL
LLLLLLLLLLLLLLLLLLLLLLLLLLLL
`, { spots: seats([4, 10, 16, 22], 0, -1) })

export const cot = piece('cot', '[========]', 'uQQQQQQQQu')

export const bucket = piece('bucket', '\\_/', 'qqq')

const JUKEBOX = String.raw`
 .-------.
/ ((o o)) \
|=========|
|:|:|:|:|:|
|_________|
`
export const jukebox = piece('jukebox', JUKEBOX, inked(JUKEBOX, 'w', { '(': 'J', ')': 'J', o: 'Q', ':': 'J', '=': 'q' }))

/**
 * A rug is floor, walked on, a border `m` round a field `M`. `marks` are
 * cells `[x, y]` of the field that carry an ornament glyph instead.
 * @param {number} w
 * @param {number} h
 * @param {{ at: [number, number], ch: string }[]} [marks]
 */
export function rug(w, h, marks = []) {
  const art = Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) =>
    marks.find((m) => m.at[0] === x && m.at[1] === y)?.ch ?? (y === 0 || y === h - 1 || x === 0 || x === w - 1 ? ';' : ':')))
  const paint = Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) =>
    y === 0 || y === h - 1 || x === 0 || x === w - 1 ? 'm' : 'M'))
  return piece('rug', art.map((r) => r.join('')).join('\n'), paint.map((r) => r.join('')).join('\n'), { floor: true })
}
