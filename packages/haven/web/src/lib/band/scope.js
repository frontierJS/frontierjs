// scope.js — the loft's scope: a trace per part of the band, the way a heart
// monitor draws a beat, scrolling right to left. A column is `COL_MS` of the
// wall clock and its glyph is how loud that part's own track peaked in it
// (`createBand().levels`), so every screen in the loft draws the same trace
// as it hears the same beat, and a kick is a spike where a pad is a plateau.
//
// A level is in decibels under the part's own `CEIL`: the parts are mixed at
// gains up to seven times apart, and on one scale the singer would never leave the
// floor while the drums never left the top.
import { PARTS, RATE } from '#shared/band.js'

/** The wall-clock ms one column of a trace covers. */
export const COL_MS = 50

/** Samples a column covers. */
export const COL_N = (COL_MS / 1000) * RATE

// Each part's loudest column over five songs drawn far apart (#0 #1 #7 #42 #99).
// A gain changed in `band.js` moves its part's here.
const CEIL  = { guitar: 0.35, singer: 0.18, drums: 1.75, bass: 0.44, keys: 0.22 }
const RANGE = 20
const GLYPHS = '▁▂▃▄▅▆▇█'

/** One part's peaks as a row of glyphs: silence is the flat line along the bottom. */
export function trace(part, peaks) {
  const ceil = CEIL[part]
  let row = ''
  for (const v of peaks) {
    const level = v > 0 ? 1 + (20 * Math.log10(v / ceil)) / RANGE : 0
    row += GLYPHS[Math.round(Math.max(0, Math.min(1, level)) * (GLYPHS.length - 1))]
  }
  return row
}

/**
 * Every part's trace for the `cols` columns ending at the last column the
 * wall clock has finished by `ms`, in `PARTS` order.
 */
export function traces(band, ms, cols) {
  const end  = Math.floor(ms / COL_MS) * COL_MS
  const from = Math.round(((end - cols * COL_MS) / 1000) * RATE)
  return band.levels(from, cols, COL_N).map((peaks, i) => trace(PARTS[i], peaks))
}
