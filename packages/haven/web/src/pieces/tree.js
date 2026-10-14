// src/pieces/tree.js — a tree in leaf, on its trunk and roots.
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
`)
