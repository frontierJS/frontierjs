// src/home-row.js — the left hand's keys (`IDEAS/haven.md` 9.4): `a s d f` in
// NORMAL while the right walks on `h j k l`, each keeping what the key means
// in vim. An operator waits for the key after it, as vim's do:
//
//   d          a bolt the way the figure faces, once the engine's timeout passes
//   d h|j|k|l  a bolt that way;  dd  a volley, all four ways
//   f <letter> walk to the nearest member whose nick starts with it
//   s <char>   draw the figure as that character, or an emoji;  s Space  as itself again
//   a <char>   chalk the cell behind the figure
//
// The table is toolbelt's `/keys` (`IDEAS/keys.md` 3.2): `d` is a binding and
// a prefix, so it waits the one ambiguity timeout (`FJS-D1385`), and `f s a`
// are await-chars. `HomeRow.mesa` hands it to mesa's `keys()` on the line, so
// the terminal runtime reads it ahead of the shell's keys (3.5): the key after
// an operator is its own, never the shell's `a` into INSERT or `l` as an
// arrow, and one it cannot take is swallowed, as vim's `d` swallows a key
// that is no motion.

import { keymap } from '@frontierjs/toolbelt/keys'
import { glyphOf, shapeOf } from '../../../../api/src/shape.ts'

export const HOME_ROW = keymap({
  d:  'bolt',
  dh: 'bolt west', dj: 'bolt south', dk: 'bolt north', dl: 'bolt east',
  dd: 'volley',
  f:  { await: 'find' },
  s:  { await: 'shape' },
  a:  { await: 'chalk' },
})

const FACING = { bolt: null, 'bolt west': 'w', 'bolt south': 's', 'bolt north': 'n', 'bolt east': 'e' }

/** What the scene does for a home-row action and its await-char, or null for an argument it cannot use. */
export function homeAction(action, arg) {
  if (action in FACING) return { act: 'bolt', facing: FACING[action] }
  if (action === 'volley') return { act: 'volley' }
  if (action === 'find') return /^[a-z0-9]$/i.test(arg) ? { act: 'find', letter: arg.toLowerCase() } : null
  if (action === 'shape') return arg === ' ' ? { act: 'shape', ch: null } : shapeOf(arg) ? { act: 'shape', ch: shapeOf(arg) } : null
  if (action === 'chalk') return glyphOf(arg) ? { act: 'chalk', ch: glyphOf(arg) } : null
  return null
}
