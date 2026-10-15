// src/pieces/sconce.js — a candle in a bracket on a wall. Its flame is `U`, a
// light of radius 2 that holds still: the light of a corner, not a room.
import { piece } from './index.js'

export const sconce = piece(
  'sconce',
  String.raw`
 *
\=/
`,
  String.raw`
 U
lll
`,
  { palette: { U: { fg: '#fcd34d', light: 2 } } }
)
