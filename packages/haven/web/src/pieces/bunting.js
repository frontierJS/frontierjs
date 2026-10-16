// src/pieces/bunting.js — what a room hangs along a wall for the season: a
// vine of blossom in spring, leaves in fall, a pine garland with lights in
// winter, and nothing in summer. All of it is overhead, so the floor under it
// is walked and no season moves a wall.
import { piece } from './index.js'

const run = (pattern, width) => pattern.repeat(Math.ceil(width / pattern.length)).slice(0, width)

/** A strand `width` cells wide, hung on one row. */
export function bunting(width) {
  const look = (pattern, paint, palette) => piece('bunting', run(pattern, width), run(paint, width), { overhead: 1, palette })
  return piece('bunting', ' ', ' ', {
    seasons: {
      spring: look('~~*~~~o~~', 'ZZPZZZYZZ', {
        Z: { fg: '#65a30d' }, P: { fg: '#f9a8d4' }, Y: { fg: '#fde047' },
      }),
      fall: look('~❧~~❧~~~', 'DRDDODDD', {
        D: { fg: '#92400e' }, R: { fg: '#c2410c' }, O: { fg: '#d97706' },
      }),
      winter: look('~~*~~o~~*', 'EELEEJEEL', {
        E: { fg: '#166534' }, J: { fg: '#dc2626' },
        L: { fg: ['#fde047', '#f472b6', '#22d3ee', '#a3e635'], chars: '*+*+', ms: 700, flicker: true },
      }),
    },
  })
}
