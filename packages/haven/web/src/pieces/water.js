// src/pieces/water.js — water and what floats or crosses it: the canal's and
// the docks' water, the boards laid over it (a bridge, a pier, a jetty), a
// rowboat, a bollard. Paint letters are the scene's (`b` water, `u` boards,
// `q` bollard).
import { piece } from './index.js'

/**
 * A pool `w` by `h` cells, every cell water but the ones `dry(dx, dy)` names.
 * A cell has one owner, so what stands in the water is cut out of it and the
 * pool is not a rectangle. `/fish` reads this piece by its name (`WATER` in
 * `api/src/fishing.ts`).
 * @param {number} w
 * @param {number} h
 * @param {(dx: number, dy: number) => boolean} [dry]
 */
export function water(w, h, dry = () => false) {
  const rows = [...Array(h)].map((_, dy) => [...Array(w)].map((_, dx) => dry(dx, dy) ? ' ' : '~').join(''))
  return piece('water', rows.join('\n'), rows.map((r) => r.replace(/~/g, 'b')).join('\n'))
}

/**
 * Boards over water, walked on: `name` is what the scene calls them.
 * @param {string} name
 * @param {number} w
 * @param {number} h
 * @param {object} [options] a pier's `crumbles`
 */
export const deck = (name, w, h, options = {}) => piece(name,
  [...Array(h)].map(() => '='.repeat(w)).join('\n'),
  [...Array(h)].map(() => 'u'.repeat(w)).join('\n'),
  { floor: true, ...options })

export const rowboat = piece('rowboat', String.raw`
~~\____|____/~
~~~\________/~
`, String.raw`
bbuuuuuuuuuuub
bbbuuuuuuuuuub
`)

export const bollard = piece('bollard', 'o', 'q')
