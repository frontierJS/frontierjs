// src/checkers.js — the checkers board as plain rows of text (`IDEAS/haven.md`
// 9.1b), what `components/Booth.mesa` places in the booth's middle column.
// Target-neutral and pure, so a test lays a game out without a screen. The
// rules and the board's string are the server's (`api/src/checkers.ts`); this
// only reads them.
//
// The board is drawn from the viewer's side: their own pieces `o` and `O`
// (a king) at the bottom, the other's `x` and `X` at the top, so a member sees
// the same picture whichever color they were dealt. A dark square is `.`, a
// light one a space. The files and ranks keep their real names, so reading a
// square off the picture is what `/move` takes.

import { FILES, sideOf } from '../../api/src/checkers.ts'

/** The board's width in cells: a rank's number, a space, and eight squares a space apart. */
export const BOARD_W = 17

/** Rows a drawn board takes: the files, then the eight ranks. */
export const BOARD_H = 9

/** The side `me` plays in `game`, or null when they are in neither seat. */
export const sideFor = (game, me) => String(game?.redId) === String(me) ? 'r' : String(game?.blackId) === String(me) ? 'b' : null

/**
 * The picture: `files` and then a row a rank, from the viewer's side. A viewer
 * in neither seat sees red's.
 * @param {{ board: string }} game
 * @param {'r'|'b'|null} side
 */
export function boardRows(game, side) {
  const flip  = side === 'b'
  const files = [...FILES]
  if (flip) files.reverse()
  const rows = [`  ${files.join(' ')}`]
  for (let r = 0; r < 8; r++) {
    const rank = flip ? r + 1 : 8 - r
    const cells = []
    for (let c = 0; c < 8; c++) {
      const col  = flip ? 7 - c : c
      const ch   = game.board[(8 - rank) * 8 + col]
      const dark = (col + rank) % 2 === 1
      const mine = side ? sideOf(ch) === side : sideOf(ch) === 'r'
      cells.push(ch === '.' ? (dark ? '.' : ' ') : (ch === ch.toUpperCase() ? (mine ? 'O' : 'X') : (mine ? 'o' : 'x')))
    }
    rows.push(`${rank} ${cells.join(' ')}`)
  }
  return rows
}

/**
 * The line under the board.
 * @param {{ turn: 'r'|'b', winnerId: number|null, last: string|null, redId: number, blackId: number }|null} game
 * @param {{ me: number|string, nicks: Record<number, string> }} o
 */
export function status(game, { me, nicks }) {
  if (!game) return 'No game yet · /checkers begins one'
  const name = (id) => nicks[id] ?? 'they'
  const last = game.last ? ` · ${game.last}` : ''
  if (game.winnerId !== null) {
    const won = String(game.winnerId) === String(me) ? 'You won' : `${name(game.winnerId)} won`
    return `${won}${last} · /checkers plays again`
  }
  const side = sideFor(game, me)
  if (!side) return `${name(game.turn === 'r' ? game.redId : game.blackId)} to move${last}`
  return game.turn === side
    ? `Your move${last} · /move c3 d4 · /resign`
    : `${name(game.turn === 'r' ? game.redId : game.blackId)} to move${last}`
}
