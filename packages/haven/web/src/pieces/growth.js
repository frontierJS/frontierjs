// src/pieces/growth.js — what grows or lies where it fell, out of doors: the
// glade's oak, the island's palm, the ravine's juniper, the sheriff's cactus,
// the woods' stump and log. `tree` is the one that has seasons (`tree.js`).
// Paint letters are the scene's (`t` `T` leaf, `u` trunk, `j` `J` juniper,
// `G` cactus).
import { piece, inked } from './index.js'

// The canopy is in the air and walked under; the trunk is a wall. The glade's
// night door is on the trunk's foot, its fourteenth column.
export const oak = piece('oak', String.raw`
        .&&&&&&&&&&.
    .&&&&&&&&&&&&&&&&&&.
  (&&&&&&&&&&&&&&&&&&&&&&)
 (&&&&&&&&&&&&&&&&&&&&&&&&)
  '&&&&&&&&&&&&&&&&&&&&&&'
     '&&&&&&||||&&&&&&'
            ||||
            ||||
          _/||||\_
`, String.raw`
        tTTTTTTTTTTt
    tTTTTTTTTTTTTTTTTTTt
  tTTTTTTTTTTTTTTTTTTTTTTt
 tTTTTTTTTTTTTTTTTTTTTTTTTt
  tTTTTTTTTTTTTTTTTTTTTTTt
     tTTTTTTuuuuTTTTTTt
            uuuu
            uuuu
          uuuuuuuu
`, { overhead: 5 })

// The fronds are in the air and walked under; the trunk is a wall.
export const palm = piece('palm', String.raw`
.-\|/-.
  /|\
   )
   (
  _)_
`, String.raw`
TTTTTTT
  TTT
   u
   u
  uuu
`, { overhead: 2 })

export const juniper = piece('juniper', String.raw`
 .%%.
(%%%%)
  ||
`, String.raw`
 jJJj
jJJJJj
  uu
`)

const CACTUS = String.raw`
  ,_,
_ | | _
| | | |
|_| | |
  | |_|
  | |
 [___]
`
export const cactus = piece('cactus', CACTUS, inked(CACTUS, 'G', { '[': 'T', ']': 'T', '_': 'T' }))

export const stump = piece('stump', String.raw`
 ___
(___)
 |_|
`, String.raw`
 uuu
uuuuu
 uuu
`)

export const log = piece('log', String.raw`
 ________
(________)
`, String.raw`
 uuuuuuuu
uuuuuuuuuu
`)
