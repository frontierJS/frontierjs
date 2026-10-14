// src/pieces/table.js — a table with a stool at each end, a mug and a candle on it.
import { piece } from './index.js'

export const table = piece('table', String.raw`
 .-------.
o|U  i  U|o
 '-------'
`, String.raw`
 ttttttttt
ttc  y  ctt
 ttttttttt
`)
