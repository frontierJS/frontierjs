// src/pieces/candle.js — a candle on the booth's table, the one light between
// the two heads. Every state of it is the same cells under a different
// palette: the tip has three cells, `l` leaning left, `i` upright and `j`
// leaning right, of which a scene shows one and blanks the others; `Y` is the
// flame's body, `k` the wick (an ember once blown out, the smoke rising off
// the tip cells), and `h` the pool of light on the table. A state is a
// palette swap rather than a second piece, because a piece placed over the
// cells of one still standing throws.
import { piece } from './index.js'

export const candle = piece(
  'candle',
  String.raw`
   \)/
   (.)
    |
   _|_
.:'. .':.
`,
  String.raw`
   lij
   YkY
    w
   cwc
hhhh hhhh
`
)
