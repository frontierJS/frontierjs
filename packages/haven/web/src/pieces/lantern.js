// src/pieces/lantern.js — a lantern hung from a beam. All of it is overhead,
// so a figure walks under it; its flame is `J`, a light of radius 3 and a
// flicker. A dark scene's `sight` is a figure's, not this.
import { piece } from './index.js'

export const lantern = piece(
  'lantern',
  String.raw`
 |
/_\
[*]
`,
  String.raw`
 l
lll
lJl
`,
  { overhead: 3, palette: { J: { fg: ['#fbbf24', '#f59e0b', '#fde047', '#fbbf24'], ms: 600, flicker: true, light: 3 } } }
)
