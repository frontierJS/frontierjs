// src/pieces/flip.js — a drawing turned over. A terminal cell cannot transform
// its glyph, so a flip draws a different character that looks like the turned
// one; a glyph with no lookalike stays itself, which is right for `O` and `X`
// and wrong for `F`. Every lookalike is one cell wide by `Bun.stringWidth`; a
// wide one would shift the rest of its row.

// Each token is a pair that turns into each other.
const pairs = (tokens) => Object.fromEntries(tokens.split(' ').flatMap(([a, b]) => [[a, b], [b, a]]))

/** Left to right: `/` is `\`, `b` is `d`. */
export const MIRROR = pairs('/\\ () [] {} <> bd pq EƎ RЯ NИ SƧ')

/** Top to bottom: `/` is `\`, `^` is `v`, `b` is `p`. */
export const FLIP_V = pairs('/\\ ^v _‾ \', bp dq MW nu A∀ VΛ !¡')

const turn = (row, swap) => [...row].map((ch) => swap[ch] ?? ch).join('')

/** The rows mirrored left to right, padded to the widest so their left edges stay aligned. Pass `{}` as `swap` for a paint. */
export function flipH(rows, swap = MIRROR) {
  const width = Math.max(...rows.map((r) => [...r].length))
  return rows.map((r) => turn([...r, ...' '.repeat(width - [...r].length)].reverse().join(''), swap))
}

/** The rows mirrored top to bottom. Pass `{}` as `swap` for a paint. */
export const flipV = (rows, swap = FLIP_V) => [...rows].reverse().map((r) => turn(r, swap))
