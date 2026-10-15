// src/pieces/lamp.js — a street lamp. Its bulb is `Y`, a light of radius 4 and
// a flicker. A scene that wants another radius names `Y` itself (the cellar's
// is 5); one that does not need say nothing.
import { piece } from './index.js'

export const lamp = piece(
  'lamp',
  String.raw`
(o)
 |
 |
_|_
`,
  String.raw`
lYl
 l
 l
lll
`,
  { overhead: 3, palette: { Y: { fg: ['#fde047', '#facc15', '#fde047', '#fbbf24'], ms: 700, flicker: true, light: 4 } } }
)
