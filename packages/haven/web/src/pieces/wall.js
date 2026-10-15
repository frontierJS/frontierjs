// src/pieces/wall.js — what hangs on or is set into an indoor wall: a window,
// a wanted poster, a neon sign.
import { piece, inked } from './index.js'

// Every pane cell is snow: the scene's `x` entry cycles a glyph through specks
// and flakes over the night's blue. It is never a blank, since a cycling cell
// that blanks is one `scenes.test.js` refuses.
export const window = piece('window', String.raw`
.------.------.
|::::::|::::::|
|::::::|::::::|
|------+------|
|::::::|::::::|
|::::::|::::::|
'------'------'
`, String.raw`
wwwwwwwwwwwwwww
wxxxxxxwxxxxxxw
wxxxxxxwxxxxxxw
wwwwwwwwwwwwwww
wxxxxxxwxxxxxxw
wxxxxxxwxxxxxxw
wwwwwwwwwwwwwww
`)

/**
 * A poster is 14 wide: WANTED, four rows of face, the reward. The border is
 * `u`, the word `k`, the reward `s`, and a face row takes the letter its
 * `inks` gives it.
 * @param {string[]} face  four rows, 12 wide
 * @param {string[]} inks  one paint letter per face row
 * @param {string} sum
 */
export const poster = (face, inks, sum) => {
  const left = Math.floor((12 - sum.length) / 2)
  const rows = [
    '.------------.',
    '|   WANTED   |',
    ...face.map((r) => `|${r}|`),
    `|${' '.repeat(left)}${sum}${' '.repeat(12 - left - sum.length)}|`,
    "'------------'",
  ]
  const ink = (row, letter) => [...row].map((c, x) => c === ' ' ? ' ' : x === 0 || x === 13 ? 'u' : letter).join('')
  const paint = rows.map((row, y) =>
    y === 0 || y === rows.length - 1 ? 'u'.repeat(14)
      : y === 1 ? ink(row, 'k')
      : y === rows.length - 2 ? ink(row, 's')
      : ink(row, inks[y - 2]))
  return piece('poster', rows.join('\n'), paint.join('\n'))
}

const NEON = String.raw`
.~~~~~~~~~~~.
(  COFFEE   )
'~~~~~~~~~~~'
`
/** Its letters are `N`, a light; the tube round them `c`. */
export const neon = piece('neon', NEON, inked(NEON, 'c', { C: 'N', O: 'N', F: 'N', E: 'N' }))
