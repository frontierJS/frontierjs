// src/pieces/kitchen.js — the kitchen's fittings (`scenes/Kitchen.mesa`):
// the ticket rail across the back wall, the line the cooks stand behind, the
// 86 board, the pass and the heat lamps over it, and what makes it a working
// kitchen around them: the range behind the cooks, the sink, the stockpot,
// the prep block, the produce, the walk-in, the mop and the service bell. The brigade
// (`components/Brigade.mesa`) finds each by `stage.placed()` and reads its
// size off the art, so a fitting moved or resized here or in the scene moves
// what is drawn on it.
import { piece, inked } from './index.js'

/** A ticket on the rail, and the gap between two. */
export const TICKET = { w: 14, h: 5, gap: 1 }

const steel = (art, end = 'S') => art.replace(/^./, end).replace(/.$/, end).replace(/[^ S]/g, 's')

const RAIL = `o${'='.repeat(89)}o`
export const rail = piece('rail', RAIL, steel(RAIL))

const LINE = `[${'='.repeat(86)}]`
export const line = piece('line', LINE, steel(LINE))

const PASS = `[${'_'.repeat(59)}]`
export const pass = piece('pass', PASS, steel(PASS))

/** A frame whose inside the brigade writes. */
export const board = (() => {
  const w = 22, h = 8
  const art = [`.${'-'.repeat(w - 2)}.`, ...Array(h - 2).fill(`|${' '.repeat(w - 2)}|`), `'${'-'.repeat(w - 2)}'`]
  return piece('board', art.join('\n'), art.map((r) => r.replace(/[^ ]/g, 'b')).join('\n'))
})()

/** A hood every ten cells across the pass; `Y` is the scene's flickering heat. */
export const lamps = (() => {
  const row = [...' '.repeat(PASS.length)].map((_, i) => (i % 10 === 5 ? 'v' : ' ')).join('')
  return piece('lamps', row, row.replace(/v/g, 'Y'))
})()

/** The range behind the line, as wide as it: a burner every seventh cell, `F` the flame. */
export const range = (() => {
  const inner = [...' '.repeat(LINE.length - 2)].map((_, i) => '(@)='[(i % 7) - 2] ?? '=').join('')
  const art = `[${inner}]`
  return piece('range', art, inked(art, 's', { '[': 'S', ']': 'S', '(': 'k', ')': 'k', '@': 'F' }))
})()

const SINK = String.raw`
 _|_
|~~~|
'---'
`
export const sink = piece('sink', SINK, inked(SINK, 's', { '~': 'q' }))

// `a` is the steam, which the scene animates.
const POT = String.raw`
 ' '
.---.
|   |
'(@)'
`
export const stockpot = piece('stockpot', POT, String.raw`
 a a
kkkkk
k   k
ksFsk
`)

const BLOCK = String.raw`
.---------------------.
| /  ooo  ooo  %%% >> |
'---------------------'
`
export const prep = piece('prep', BLOCK, String.raw`
uuuuuuuuuuuuuuuuuuuuuuu
u s  rrr  nnn  vvv oo u
uuuuuuuuuuuuuuuuuuuuuuu
`)

/** A bin of produce, `ink` the paint letter of what is in it. */
export const bin = (ink) => {
  const art = ".-----.\n|ooooo|\n'-----'"
  return piece('bin', art, inked(art, 'u', { o: ink }))
}

const WALKIN = String.raw`
.-.
|*|
|o|
'-'
`
export const walkIn = piece('walk-in', WALKIN, inked(WALKIN, 's', { '*': 'i', o: 'k' }))

const MOP = String.raw`
  /
\_/
`
export const mop = piece('mop', MOP, String.raw`
  u
sss
`)

export const plates = piece('plates', '___\n===', 'nnn\nnnn')

/** The service bell on the pass; the brigade rings it. */
export const bell = piece('bell', 'ô', 'B')
