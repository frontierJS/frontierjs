// src/pieces/bar.js — the tavern's bar, with a stool every sixth cell
// along it, the whole width of the room. A stool is a solo seat: sat on and
// paired with nobody, so it is never a booth. `Bar.mesa` finds the bar by this piece and reads its stools.
import { piece } from './index.js'

const WIDTH = 92
export const STOOLS = Array.from({ length: 15 }, (_, i) => 4 + i * 6)

const stoolRow = (put) => {
  const r = Array(WIDTH).fill(' ')
  for (const x of STOOLS) r[x] = put
  return r.join('').trimEnd()
}

export const bar = piece('bar', [
  '_'.repeat(WIDTH),
  `|${'='.repeat(WIDTH - 2)}|`,
  `'${'-'.repeat(WIDTH - 2)}'`,
  stoolRow('o'),
].join('\n'), [
  'w'.repeat(WIDTH),
  `w${'W'.repeat(WIDTH - 2)}w`,
  'w'.repeat(WIDTH),
  stoolRow('t'),
].join('\n'), { spots: Object.fromEntries(STOOLS.map((dx, i) => [`stool-${i}`, { kind: 'seat', dx, dy: 3, stand: { dx, dy: 4 }, solo: true }])) })
