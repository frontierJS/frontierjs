// src/pieces/work.js — what a place of work leaves lying about: the range's
// hay bales, the lodge's woodpile, the mine's rails. Paint letters are the
// scene's (`h` `H` hay, `u` `W` wood, `l` rail).
import { piece, inked } from './index.js'

/** @param {number} rows a column of bales two wide */
export const bales = (rows) => piece('bales', Array(rows).fill('%%').join('\n'), Array(rows).fill('hH').join('\n'))

const WOOD = String.raw`
   (@)
 (@)(@)
(@)(@)(@)
`
export const woodpile = piece('woodpile', WOOD, inked(WOOD, 'u', { '@': 'W' }))

/** Track laid along the floor, walked on. @param {number} w */
export const rails = (w) => piece('rails', '='.repeat(w), 'l'.repeat(w), { floor: true })
