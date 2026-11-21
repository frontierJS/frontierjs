// src/pieces/quarter.js — a building of the framework quarter (`IDEAS/haven.md`
// 9.2): a house with a package's name on its front, a roof in its own color, and
// a `wall` spot on the cell below its door. Standing there is reading the wall
// (`components/Wall.mesa`). The piece carries its `pkg`, which the wall finds it by.
import { piece } from './index.js'

/** Every building is this wide, so the scene lays them out on a grid. */
export const BUILDING_W = 26
export const BUILDING_H = 6

const centered = (text, width) => {
  const left = Math.floor((width - text.length) / 2)
  return ' '.repeat(left) + text + ' '.repeat(width - text.length - left)
}

/**
 * @param {{ pkg: string, sign: string, roof: string }} b  `roof` is a palette letter
 */
export function building({ pkg, sign, roof }) {
  const W = BUILDING_W
  const label = `[ ${sign} ]`
  const doorAt = Math.floor((W - 3) / 2)
  const rows = [
    ` .${'-'.repeat(W - 4)}. `,
    `/${centered(label, W - 2)}\\`,
    `|${'='.repeat(W - 2)}|`,
    '| []   []   []   []   [] |',
    `|${' '.repeat(W - 2)}|`,
    `|${'_'.repeat(doorAt - 1)}|n|${'_'.repeat(W - doorAt - 3 - 1)}|`,
  ]
  const ink = (ch, y) => {
    if (ch === ' ') return ' '
    if (y === 0 || (y === 1 && (ch === '/' || ch === '\\'))) return roof
    if (y === 1) return ch === '[' || ch === ']' ? 'S' : 's'
    if (y === 3 && (ch === '[' || ch === ']')) return 'y'
    if (ch === 'n') return 'd'
    return 'w'
  }
  const paint = rows.map((r, y) => [...r].map((ch) => ink(ch, y)).join(''))
  return { ...piece(`${pkg}-building`, rows.join('\n'), paint.join('\n'), {
    spots: { wall: { dx: doorAt + 1, dy: BUILDING_H } },
  }), pkg }
}
