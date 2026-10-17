// src/booth.js — the booth's middle column, as plain data (`IDEAS/haven.md`
// Phase 8): the lines two members said across one table, each a bubble that
// stays, the oldest at the top and the newest under it. This member's bubbles
// stand against the left of the column and theirs against the right, the sides
// their faces are on, so who said what is read off the side before it is read
// off a name. When the
// column is full the top scrolls off, as any chat does; the lines themselves
// are the room's and stay.
//
// Target-neutral and pure, so a test lays out a conversation without a
// screen; `components/Booth.mesa` places what this returns. Every width is
// counted in cells (`cells.js`), since a line may hold an emoji or 中文.

import { cells, clip } from '../scene/cells.js'

/** The booth's column: wide enough for a sentence, narrow enough to leave each member a side. */
export const COLUMN = { w: 50, h: 24 }

/** `text` broken at spaces into rows of at most `width` cells; a word longer than a row is cut. */
export function wrap(text, width) {
  const rows = []
  let row = ''
  for (let word of text.trim().split(/\s+/)) {
    while (cells(word) > width) {
      if (row) { rows.push(row); row = '' }
      // A row narrower than the word's first grapheme still takes it, or the loop never ends.
      const head = clip(word, width) || [...new Intl.Segmenter().segment(word)][0].segment
      rows.push(head)
      word = word.slice(head.length)
    }
    if (!row) row = word
    else if (cells(row) + 1 + cells(word) <= width) row += ' ' + word
    else { rows.push(row); row = word }
  }
  if (row) rows.push(row)
  return rows
}

/**
 * One line as the rows of its bubble: `( words )`, the same width on every row.
 * `gap` is the space inside each paren — the square's is none, so a line that
 * fits one row reads `(words)`, the spelling every drive looks for over a
 * figure. Past `most` rows the last row kept ends in `…`.
 * @param {string} body
 * @param {number} width  the column's width; the bubble is up to this wide
 * @param {{ gap?: string, most?: number }} [o]
 */
export function bubble(body, width = COLUMN.w, { gap = ' ', most = Infinity } = {}) {
  const room = width - 2 - 2 * gap.length
  let rows = wrap(body, room)
  if (rows.length > most) {
    rows = rows.slice(0, most)
    rows[most - 1] = `${clip(rows[most - 1], room - 1)}…`
  }
  const inner = Math.max(...rows.map(cells))
  const pad   = ' '.repeat(1 + gap.length)
  return rows.map((r, i) => `${i === 0 ? `(${gap}` : pad}${r}${' '.repeat(inner - cells(r))}${i === rows.length - 1 ? `${gap})` : pad}`)
}

/**
 * The rows to draw, each `{ key, x, y, text }` in the column's own cells.
 * @param {{ id: number, memberId: number|string, roomId: number, body: string }[]} said  as the store holds them: newest first
 * @param {{ me: number|string, roomId: number, width?: number, height?: number }} o
 */
export function transcript(said, { me, roomId, width = COLUMN.w, height = COLUMN.h }) {
  const rows = []
  for (const line of [...said].reverse()) {
    if (line.roomId !== roomId) continue
    const mine = String(line.memberId) === String(me)
    bubble(line.body, width).forEach((text, i) => {
      rows.push({ key: `${line.id}:${i}`, x: mine ? 0 : width - cells(text), text })
    })
  }
  return rows.slice(-height).map((r, y) => ({ ...r, y }))
}
