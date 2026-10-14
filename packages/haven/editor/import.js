// editor/import.js — a block of art pasted into the editor, recognized as
// placed pieces (`FJS-D997`: recognition is the importer, never the runtime).
//
// Pieces are found largest first, and a match over a cell a larger piece
// holds is not one, so a table's `|` is never a wall. Two matches of one size
// on a cell are `twice`, and a glyph no piece claims is `unclaimed` — each a
// cell the page lists, since either one is a drawing the pieces at hand
// cannot make. Only a piece's glyphs are matched, so a space inside it
// matches anything.
//
// Pure: the art and the pieces in, the placements out, so it is a bun test.

/**
 * @param {string} art
 * @param {Array<{ ident: string, piece: object }>} known  what a placement may name
 * @returns {{ placements: Array<{ ident: string, piece: object, x: number, y: number }>, twice: object[], unclaimed: object[] }}
 */
export function recognize(art, known) {
  const rows = art.replace(/^\n/, '').replace(/\n$/, '').split('\n')
  const owner = rows.map((row) => Array(row.length).fill(null))
  const placements = [], twice = []
  const sizes = [...new Set(known.map((k) => k.piece.cells.length))].sort((a, b) => b - a)
  for (const size of sizes) {
    const found = []
    for (const k of known.filter((q) => q.piece.cells.length === size)) {
      const [first] = k.piece.cells
      rows.forEach((row, Y) => [...row].forEach((ch, X) => {
        if (ch !== first.ch) return
        const x = X - first.dx, y = Y - first.dy
        const fits = k.piece.cells.every((c) => rows[y + c.dy]?.[x + c.dx] === c.ch && owner[y + c.dy][x + c.dx] === null)
        if (fits) found.push({ ...k, x, y })
      }))
    }
    for (const m of found) {
      for (const c of m.piece.cells) {
        const x = m.x + c.dx, y = m.y + c.dy
        const held = owner[y][x]
        if (held && held !== m) twice.push({ x, y, pieces: [held.ident, m.ident] })
        else owner[y][x] = m
      }
      placements.push({ ident: m.ident, piece: m.piece, x: m.x, y: m.y })
    }
  }
  const unclaimed = []
  rows.forEach((row, y) => [...row].forEach((ch, x) => { if (ch !== ' ' && !owner[y][x]) unclaimed.push({ x, y, ch }) }))
  return { placements, twice, unclaimed }
}
