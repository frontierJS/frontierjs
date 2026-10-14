// src/pieces/index.js — what a piece is: a small drawing and its paint, the
// same shape, placed on a stage by `<Piece of={…} x y>` (`FJS-D997`).
//
// Only its glyphs are cells, so a space inside a piece claims nothing and a
// frame is only its border. Leading and trailing newlines are dropped, so a
// piece is written as a block under its name. A `floor` piece is walked on —
// the tavern's rug — where every other piece is a wall.

/**
 * @param {string} name
 * @param {string} art    the glyphs
 * @param {string} paint  one palette letter per glyph, a space where the art has one
 * @param {{ floor?: boolean }} [options]
 */
export function piece(name, art, paint, { floor = false } = {}) {
  const lines = (s) => s.replace(/^\n/, '').replace(/\n$/, '').split('\n')
  const a = lines(art), p = lines(paint)
  const cells = []
  a.forEach((row, dy) => [...row].forEach((ch, dx) => {
    if (ch !== ' ') cells.push({ dx, dy, ch, key: p[dy]?.[dx] ?? ' ' })
  }))
  return { name, art: a.join('\n'), paint: p.join('\n'), cells, floor }
}
