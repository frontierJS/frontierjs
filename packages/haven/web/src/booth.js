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
// screen; `components/Booth.mesa` places what this returns.

/** The booth's column: wide enough for a sentence, narrow enough to leave each member a side. */
export const COLUMN = { w: 50, h: 24 }

/** `text` broken at spaces into rows of at most `width` cells; a word longer than a row is cut. */
export function wrap(text, width) {
  const rows = []
  let row = ''
  for (let word of text.trim().split(/\s+/)) {
    while (word.length > width) {
      if (row) { rows.push(row); row = '' }
      rows.push(word.slice(0, width))
      word = word.slice(width)
    }
    if (!row) row = word
    else if (row.length + 1 + word.length <= width) row += ' ' + word
    else { rows.push(row); row = word }
  }
  if (row) rows.push(row)
  return rows
}

/**
 * One line as the rows of its bubble: `( words )`, the same width on every row.
 * @param {string} body
 * @param {number} width  the column's width; the bubble is up to this wide
 */
export function bubble(body, width = COLUMN.w) {
  const rows = wrap(body, width - 4)
  const inner = Math.max(...rows.map((r) => r.length))
  return rows.map((r, i) => `${i === 0 ? '( ' : '  '}${r.padEnd(inner)}${i === rows.length - 1 ? ' )' : '  '}`)
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
      rows.push({ key: `${line.id}:${i}`, x: mine ? 0 : width - text.length, text })
    })
  }
  return rows.slice(-height).map((r, y) => ({ ...r, y }))
}
