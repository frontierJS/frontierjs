// src/pieces/townhall.js — where everyone in the town hall stands
// (`layoutHall`): the board of the most wanted along the top, then a row per
// wave of `IDEAS/overview.md`, its name a light, and under it its delegates —
// one person per open idea, the idea's number under their head — dealt
// `ACROSS` to a line, so a wave with more ideas takes more lines and every
// wave after it moves down. Nothing is placed by hand.
import { piece } from './index.js'

/** Cells from one delegate's head to the next: room for the widest number, `4.21a`, and a cell either side to stand in. */
const PITCH = 7
const MARGIN = 4
/** The hall is one screen wide, the shared frame's width. */
const WIDTH = 96
const ACROSS = Math.floor((WIDTH - 2 * MARGIN) / PITCH)

/** The board's rows: the most wanted, best first. */
export const BOARD_ROWS = 5
const BOARD_W = 72

/** A status's paint letter: what is wrong today is red, what is half done amber, a plain idea pale, a paper still being argued blue. */
const INK = { idea: 'i', defect: 'd', partial: 'p', 'part shipped': 'p', 'part-shipped': 'p' }
const inkOf = (status) => INK[status] ?? 'q'

/** One delegate: a head and, under it, the number they stand for. The piece carries its `idea`, which `Assembly.mesa` finds it by. */
export function delegate(idea) {
  const hx = Math.floor((idea.id.length - 1) / 2)
  const art = `${' '.repeat(hx)}o\n${idea.id}`
  const paint = `${' '.repeat(hx)}${inkOf(idea.status)}\n${'l'.repeat(idea.id.length)}`
  return { ...piece('delegate', art, paint, { spots: { head: { dx: hx, dy: 0 } } }), idea: idea.id }
}

/** A wave's name over its delegates, lit like a workshop bench's. */
export function waveSign(wave) {
  const art = `[ wave ${wave.n} · ${wave.name} ]`
  return piece('wave', art, [...art].map((ch) => (ch === ' ' ? ' ' : /[\w·-]/.test(ch) ? 'n' : 'w')).join(''))
}

/** The board along the top: a frame whose inside `Assembly.mesa` writes in, its name in the top edge. */
export const boardPiece = (() => {
  const title = ' the floor: most wanted '
  const left = Math.floor((BOARD_W - 2 - title.length) / 2)
  const top = `.${'-'.repeat(left)}${title}${'-'.repeat(BOARD_W - 2 - left - title.length)}.`
  const rows = [top, ...Array(BOARD_ROWS).fill(`|${' '.repeat(BOARD_W - 2)}|`), `'${'-'.repeat(BOARD_W - 2)}'`]
  const paint = rows.map((r, i) => [...r].map((ch, x) => (ch === ' ' ? ' ' : i === 0 && x > left && x <= left + title.length ? 'n' : 'w')).join(''))
  return piece('board', rows.join('\n'), paint.join('\n'), { spots: { inner: { dx: 2, dy: 1 } } })
})()

/**
 * @param {{ n: number, name: string, ideas: { id: string, status: string }[] }[]} waves
 * @returns {{ width: number, height: number, board: { piece: object, x: number, y: number }, waves: { sign: object, x: number, y: number }[], delegates: { piece: object, x: number, y: number }[], door: { x: number, y: number }, spawn: { x: number, y: number } }}
 */
export function layoutHall(waves) {
  const board = { piece: boardPiece, x: Math.floor((WIDTH - BOARD_W) / 2), y: 2 }
  let y = board.y + BOARD_ROWS + 3
  const signs = []
  const delegates = []
  for (const wave of waves) {
    signs.push({ sign: waveSign(wave), x: MARGIN, y })
    y += 2
    wave.ideas.forEach((idea, i) => {
      const d = delegate(idea)
      if (i && i % ACROSS === 0) y += 3
      delegates.push({ piece: d, x: MARGIN + 2 + (i % ACROSS) * PITCH - d.spots.head.dx, y })
    })
    // The head row, the number row, and a row to walk under them.
    y += 4
  }
  const height = y + 2
  return {
    width: WIDTH,
    height,
    board,
    waves: signs,
    delegates,
    door: { x: MARGIN, y: height - 1 },
    spawn: { x: MARGIN, y: height - 2 },
  }
}
