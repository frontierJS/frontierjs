// src/pieces/face.js — the booth's two sides: this member's head in profile
// against the left edge of the screen and the other's against the right, each
// facing the middle, so the picture reads as two people across one table. One
// drawing; the right side is its mirror, so the two cannot drift apart.
import { piece } from './index.js'
import { flipH } from './flip.js'

// A head facing right, the back of it cut by the screen's edge. The blank rows
// on top sit the shoulders on the booth's floor. No backtick in it -- it would
// close the literal.
const HALF = String.raw`



   .---------.
 .',,,,,,,,,,,'.
/,,,,,,,,,,,,,,,\
,,,,,,,,,,,,'   |
,,,,,,,,,'      |
,,,,,,,     _   |
,,,,,,     (o    \
,,,,,             \
,.-.               >
( (              _/
,'-'            |
,,         \__   )
 ,            _.'
 \           /
  '.       .'
    '-.  .-'
      |  |
  _.--'  '--._
.'            '.
`

const rows = HALF.replace(/^\n/, '').replace(/\n$/, '').split('\n')
const width = Math.max(...rows.map((r) => r.length))

/** How far into a head the candle reaches from the side facing it, in cells: `rim` the nearest, `mid` the next. */
export const LIT = { rim: 2, mid: 6 }

/**
 * The drawing's paint: one palette letter per glyph, `key`, and with `lit`
 * the cells within `LIT` of each row's last glyph — the edge facing the
 * table — painted `lit.rim` and `lit.mid` instead.
 */
const paintOf = (art, key, lit) => art.map((r) => {
  const last = r.trimEnd().length - 1
  return [...r].map((ch, dx) => {
    if (ch === ' ') return ' '
    if (!lit) return key
    const d = last - dx
    return d < LIT.rim ? lit.rim : d < LIT.mid ? lit.mid : key
  }).join('')
})

/** A head facing right, painted `key`: this member's, on the left of the booth. */
export const leftFace = (key, lit) => piece('face', rows.join('\n'), paintOf(rows, key, lit).join('\n'))

/** A head facing left, painted `key`: the other member's, on the right of the booth. */
export const rightFace = (key, lit) =>
  piece('face', flipH(rows).join('\n'), flipH(paintOf(rows, key, lit), {}).join('\n'))

/** The drawing's size in cells. */
export const FACE = { w: width, h: rows.length }
