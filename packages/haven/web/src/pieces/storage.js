// src/pieces/storage.js — what a room keeps things in: the tavern's shelves,
// the cellar's racks, crates and chest, the sheriff's gun rack. Paint letters
// are the scene's (`u` wood, `w` timber, `c` and `e` and `p` bottles).
import { piece } from './index.js'

const SHELF_W = 92
const INNER = SHELF_W - 2
const BOTTLES = Array.from({ length: 30 }, (_, i) => 1 + i * 3)
const shelfRow = (pick) => {
  const r = Array(INNER).fill(' ')
  BOTTLES.forEach((x, i) => { r[x] = pick(i) })
  return `|${r.join('')}|`
}
const edge = (l, r) => `${l}${'-'.repeat(INNER)}${r}`
const ink = (shift) => (i) => 'cep'[(i + shift) % 3]

/** The wall behind the bar, as wide as the bar: three rows of bottles, one every third cell. */
export const shelves = piece('shelves', [
  edge('.', '.'),
  shelfRow((i) => (i % 2 ? '0' : 'U')),
  edge('|', '|'),
  shelfRow((i) => (i % 2 ? '!' : 'i')),
  edge('|', '|'),
  shelfRow((i) => (i % 2 ? '0' : 'U')),
  edge("'", "'"),
].join('\n'), [
  'w'.repeat(SHELF_W),
  shelfRow(ink(0)).replace(/\|/g, 'w'),
  'w'.repeat(SHELF_W),
  shelfRow(ink(1)).replace(/\|/g, 'w'),
  'w'.repeat(SHELF_W),
  shelfRow(ink(2)).replace(/\|/g, 'w'),
  'w'.repeat(SHELF_W),
].join('\n'))

export const wineRack = piece('wine-rack', String.raw`
.----------------------------.
|o o o o o o o o o o o o o o |
|----------------------------|
| o o o o o o o o o o o o o o|
'----------------------------'
`, String.raw`
uuuuuuuuuuuuuuuuuuuuuuuuuuuuuu
ugrgrgrgrgrgrgrgrgrgrgrgrgrg u
uuuuuuuuuuuuuuuuuuuuuuuuuuuuuu
u grgrgrgrgrgrgrgrgrgrgrgrgrgu
uuuuuuuuuuuuuuuuuuuuuuuuuuuuuu
`)

export const crates = piece('crates', String.raw`
.------.
|[]  []|
|[]  []|
'------'
`, String.raw`
uuuuuuuu
uuuuuuuu
uuuuuuuu
uuuuuuuu
`)

export const chest = piece('chest', String.raw`
 .-------.
 |  [=]  |
 '-------'
`, String.raw`
 uuuuuuuuu
 uuucccuuu
 uuuuuuuuu
`)

export const gunRack = piece('gun-rack', String.raw`
.------------.
| |  |  |  | |
| |  |  |  | |
| o  o  o  o |
'------------'
`, String.raw`
wwwwwwwwwwwwww
w q  q  q  q w
w q  q  q  q w
w u  u  u  u w
wwwwwwwwwwwwww
`)
