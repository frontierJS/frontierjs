// src/pieces/archery.js — what a bolt (`IDEAS/haven.md` 9.5) is shot with and
// at: the quiver lying in the woods and on the range, the range's targets and
// the housings of the carousel they ride (`Carousel.mesa`), and its
// scoreboard. A target is scored by the server (`pointsFor` in
// `api/src/play.ts`) by how far from its middle the bolt struck it, so the
// rings drawn here are the rings scored: the middle row is the bull, the two
// rows beside it the inner ring, the top and bottom the rim. `Scores.mesa`
// finds the board by this piece and writes in its `inner`.
import { piece } from './index.js'

/** Five arrows, lying where the floor is open. Walked onto, so a floor piece. */
export const quiver = piece('quiver', '=>', 'ee', { floor: true, pickup: { item: 'arrow', n: 5 } })

export const target = piece('target', String.raw`
 .---.
/ .-. \
|( o )|
\ '-' /
 '---'
`, String.raw`
 wwwww
w rrr w
wr y rw
w rrr w
 wwwww
`, {
  palette: {
    w: { fg: '#f5f5f4' },
    r: { fg: '#dc2626' },
    y: { fg: '#facc15' },
  },
})

/**
 * The box a carousel's riders go round under, `w` wide: two rows, a sprocket
 * over the middle of each column (`apart` from the first at `dx`). `top` puts
 * the lid on its upper row.
 */
export function housing(w, dx, apart, top) {
  const cogs = [...'='.repeat(w - 2)]
  for (const at of [dx, dx + apart]) cogs.splice(at - 2, 3, '(', '@', ')')
  const lid = `${top ? '.' : "'"}${'-'.repeat(w - 2)}${top ? '.' : "'"}`
  const teeth = `|${cogs.join('')}|`
  const lidPaint = 'e'.repeat(w), teethPaint = `e${cogs.map((c) => c === '@' ? 'g' : c === '=' ? 'l' : 'e').join('')}e`
  return piece('housing', (top ? [lid, teeth] : [teeth, lid]).join('\n'), (top ? [lidPaint, teethPaint] : [teethPaint, lidPaint]).join('\n'), {
    palette: { g: { fg: '#9ca3af' } },
  })
}

const BOARD_W = 34
const BOARD_H = 7

/** The board by the gate, its rows written by `Scores.mesa`; blank on a screen that has none. */
export const scoreboard = { ...piece('scoreboard', [
  `.${'-'.repeat(11)}[ scores ]${'-'.repeat(BOARD_W - 21)}.`,
  ...Array(BOARD_H).fill(`|${' '.repeat(BOARD_W)}|`),
  `'${'-'.repeat(BOARD_W)}'`,
  `   |${' '.repeat(BOARD_W - 6)}|`,
].join('\n'), [
  `e${'e'.repeat(11)}SssssssssS${'e'.repeat(BOARD_W - 21)}e`,
  ...Array(BOARD_H).fill(`e${' '.repeat(BOARD_W)}e`),
  `e${'e'.repeat(BOARD_W)}e`,
  `   l${' '.repeat(BOARD_W - 6)}l`,
].join('\n'), {
  palette: {
    S: { fg: '#a16207' },
    s: { fg: '#fde68a' },
  },
}), inner: { dx: 2, dy: 1, w: BOARD_W - 2, h: BOARD_H } }
