// src/pieces/chandelier.js — candles on a ring hung over the middle of a room.
// All of it is overhead, so the floor under it is walked; its flames are `C`,
// a light of radius 5, the one light a whole room is lit by.
import { piece } from './index.js'

export const chandelier = piece(
  'chandelier',
  String.raw`
    _|_
*__/ | \__*
   \_*_/
`,
  String.raw`
    lll
Clll l lllC
   llCll
`,
  { overhead: 3, palette: { C: { fg: ['#fde047', '#facc15', '#fef08a', '#fde047'], ms: 900, flicker: true, light: 5 } } }
)
