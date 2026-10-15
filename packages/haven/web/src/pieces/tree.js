// src/pieces/tree.js — a tree in each season, on its trunk and roots. The
// rows above the roots are overhead; the roots are a wall, the same cells in
// every season, so a scene swaps one season for another without moving a wall.
//
// `tree` is summer, and paints with the scene's `t`, `T` and `u`; a scene
// places `tree`, and `/season` turns it into one of the other three. They
// bring their own palette for every letter but the trunk's `u`, on letters no
// scene names, so one scene can stand all four side by side.
import { piece } from './index.js'

/** Fresh leaf with blossom through it: pink `P`, lilac `C`, yellow `Z`, white `I`. */
export const springTree = piece(
  'tree',
  String.raw`
   .&*&&.
 .&o&&*&o&.
(&*&&o&&*&&)
 '&&*&&&o&'
   '&||&'
     ||
    /__\
`,
  String.raw`
   zaIaaz
 zaCaaPaZaz
zaPaaZaaIaaz
 zaaPaaaCaz
   zauuaz
     uu
    uuuu
`,
  {
    overhead: 6,
    palette: {
      z: { fg: '#4d7c0f' },
      a: { fg: ['#a3e635', '#84cc16', '#65a30d', '#84cc16'], chars: '&&%&', ms: 900, wave: true },
      P: { fg: '#f472b6' },
      C: { fg: '#c084fc' },
      Z: { fg: '#fde047' },
      I: { fg: '#fdf4ff' },
    },
  }
)

/** Thinning orange `A` and red `K`, a leaf `E` coming down either side. */
export const fallTree = piece(
  'tree',
  String.raw`
   .&&&&.  ,
 .&&& &&&&.
(&&&&&&& &&)
,'&&& &&&&'
   '&||&'
     ||
    /__\
`,
  String.raw`
   DAKAAD  E
 DAAK AKAAD
DAKAAKAA KAD
EDAKA AKAAD
   DKuuAD
     uu
    uuuu
`,
  {
    overhead: 6,
    palette: {
      D: { fg: '#7c2d12' },
      A: { fg: ['#f59e0b', '#ea580c', '#d97706', '#ea580c'], chars: '&&%&', ms: 1100, wave: true },
      K: { fg: ['#dc2626', '#b91c1c', '#dc2626', '#c2410c'], chars: '&&%&', ms: 1100, wave: true },
      E: { fg: '#f97316' },
    },
  }
)

/** Bare branches in the trunk's `u`, snow `N` lying on them and flakes `X` falling past. */
export const winterTree = piece(
  'tree',
  String.raw`
*  .:**:.  *
 .:\:\/:/:.
.\_\ \/ /_/.
 *  \\//  *
    \||/
     ||
    /__\
`,
  String.raw`
X  NNNNNN  X
 NNuNuuNuNN
Nuuu uu uuuN
 X  uuuu  X
    uuuu
     uu
    uuuu
`,
  {
    overhead: 6,
    palette: {
      N: { fg: '#f1f5f9' },
      X: { fg: ['#e2e8f0', '#f8fafc', '#cbd5e1'], chars: '*.*', ms: 1300, flicker: true },
    },
  }
)

export const tree = piece(
  'tree',
  String.raw`
   .&&&&.
 .&&&&&&&&.
(&&&&&&&&&&)
 '&&&&&&&&'
   '&||&'
     ||
    /__\
`,
  String.raw`
   tTTTTt
 tTTTTTTTTt
tTTTTTTTTTTt
 tTTTTTTTTt
   tTuuTt
     uu
    uuuu
`,
  { overhead: 6, seasons: { spring: springTree, fall: fallTree, winter: winterTree } }
)
