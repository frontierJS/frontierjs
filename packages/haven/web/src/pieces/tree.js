// src/pieces/tree.js — a tree in leaf, on its trunk and roots. The four rows
// of leaf are overhead; the trunk is a wall.
import { piece } from './index.js'

export const tree = piece('tree', String.raw`
   .&&&&.
 .&&&&&&&&.
(&&&&&&&&&&)
 '&&&&&&&&'
   '&||&'
     ||
    /__\
`, String.raw`
   tTTTTt
 tTTTTTTTTt
tTTTTTTTTTTt
 tTTTTTTTTt
   tTuuTt
     uu
    uuuu
`, { overhead: 4 })
