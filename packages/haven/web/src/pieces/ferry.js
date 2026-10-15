// src/pieces/ferry.js — the ferry between the docks and the island. It is the
// same boat moored at both ends, bow west, so each scene lays a gangplank to
// it at its deck row and puts the door to the other end on the deck cell the
// plank meets (`GANGWAY`). The cabin and the hull close round their spaces, so
// nothing inside the boat is reached; a scene's water is cut round `hull()`
// rather than round the glyphs, or it would flood the cabin.
import { piece } from './index.js'

const ART = String.raw`
         _
        |=|
   .----'-'----.
   |[] [] [] []|
 __|___________|__
 \ o  o  o  o  o /
  \_____________/
`

export const ferry = piece('ferry', ART, String.raw`
         k
        kkk
   ccccccccccccc
   cggcggcggcggc
 rrcrrrrrrrrrrrcrr
 h g  g  g  g  g h
  hhhhhhhhhhhhhhh
`, {
  palette: {
    k: { fg: '#dc2626' },
    c: { fg: '#e5e7eb' },
    r: { fg: '#92400e' },
    h: { fg: '#1e3a8a' },
    g: { fg: ['#fde68a', '#fcd34d', '#fde68a'], ms: 1200, flicker: true, light: 1 },
  },
})

export const FERRY = { w: 18, h: 7 }

/** The deck cell a gangplank laid from the west meets; the cell west of it is free for the plank. */
export const GANGWAY = { dx: 1, dy: 4 }

/** Whether the boat covers `(dx, dy)` of its own box: its row from the first glyph to the last. */
export function hull(dx, dy) {
  const row = ART.replace(/^\n/, '').split('\n')[dy] ?? ''
  const first = row.search(/\S/)
  return first >= 0 && dx >= first && dx < row.trimEnd().length
}
