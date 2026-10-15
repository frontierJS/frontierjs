// src/pieces/ledger.js — the register on a bench (`ledgerBlock`): a slip lying
// flat for every open issue of that package, piled on the bench's top edge,
// one pile per severity — S1, S2, S3, S4 left to right — in the severity's
// color. A pile is `PILE` slips across and grows upward as it fills. The
// counts come from `ledger.data.js`, written from ISSUES.md.
import { piece } from './index.js'
import { BENCH_WIDTH } from './bench.js'

/** Cells between two piles. */
const GAP = 1

/** Slips across one pile: four piles and their gaps are one bench wide. */
export const PILE = (BENCH_WIDTH - 3 * GAP) / 4

/** Palette letter for a severity's slips — the workshop's palette names these. */
export const SEVERITY_KEY = { S1: '1', S2: '2', S3: '3', S4: '4' }

const SLIP = '━'

/**
 * The piles for `counts` (`{ S1, S2, S3, S4 }`) as a piece `rows` tall and as
 * wide as a bench, to be placed `rows` above it so the bottom row lies on it.
 * A package with none is a piece with no cells. A pile taller than `rows`
 * throws naming the bench, since a block that grew into the row above would
 * otherwise fail at mount as two pieces on one cell.
 */
export function ledgerBlock(name, counts, rows) {
  const art = Array.from({ length: rows }, () => Array(BENCH_WIDTH).fill(' '))
  const paint = Array.from({ length: rows }, () => Array(BENCH_WIDTH).fill(' '))
  Object.entries(SEVERITY_KEY).forEach(([sev, key], pile) => {
    const n = counts[sev] ?? 0
    if (Math.ceil(n / PILE) > rows) {
      throw new Error(`ledgerBlock: ${name} has ${n} ${sev} issues, a pile of ${Math.ceil(n / PILE)} rows where ${rows} fit — give its row of benches more rows in Workshop.mesa`)
    }
    for (let i = 0; i < n; i++) {
      const row = rows - 1 - Math.floor(i / PILE)
      const col = pile * (PILE + GAP) + (i % PILE)
      art[row][col] = SLIP
      paint[row][col] = key
    }
  })
  return { ...piece('ledger', art.map((r) => r.join('')).join('\n'), paint.map((r) => r.join('')).join('\n')), ledger: name, count: Object.keys(SEVERITY_KEY).reduce((a, s) => a + (counts[s] ?? 0), 0) }
}
