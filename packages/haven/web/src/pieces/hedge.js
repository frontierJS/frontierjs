// src/pieces/hedge.js — one cell of hedge, a wall; a hedge is a `<Row>` of
// them with a gap left where a path goes through. Its `G` is the scene's.
// The other seasons are walls on the same cell and bring their own letters, on
// letters no scene names, as `tree.js` does.
import { piece } from './index.js'

/** New leaf with blossom coming through it. */
const springHedge = piece('hedge', ',', 'k', {
  palette: { k: { fg: ['#84cc16', '#a3e635', '#f9a8d4'], ms: 1100, wave: true } },
})

/** Going orange and brown. */
const fallHedge = piece('hedge', ',', 'q', {
  palette: { q: { fg: ['#ea580c', '#d97706', '#b45309'], ms: 1100, wave: true } },
})

/** Bare twigs under snow. */
const winterHedge = piece('hedge', ':', 'w', { palette: { w: { fg: '#e2e8f0' } } })

export const hedge = piece('hedge', ',', 'G', { seasons: { spring: springHedge, fall: fallHedge, winter: winterHedge } })
