// src/pieces/table.js — a table with a stool at each end, a mug and a candle on it.
// The candle burns only while a stool is taken; unlit it is a white dot.
// The stools are its seats, each the other's mate: a figure walks onto one, and a second on the stool
// across is the pair a booth is made for (`api/src/booth.ts`). Each seat names
// the cell outside its stool, where a figure stands up to — a seat is never
// stood up onto, or the two would be seated again the moment they came back.
import { piece } from './index.js'

export const table = piece('table', String.raw`
 .-------.
o|U  i  U|o
 '-------'
`, String.raw`
 ttttttttt
ttc  y  ctt
 ttttttttt
`, { spots: {
  west:   { kind: 'seat', dx: 0,  dy: 1, stand: { dx: -1, dy: 1 }, mate: 'east' },
  east:   { kind: 'seat', dx: 10, dy: 1, stand: { dx: 11, dy: 1 }, mate: 'west' },
  candle: { kind: 'burn', dx: 5,  dy: 1 },
} })
