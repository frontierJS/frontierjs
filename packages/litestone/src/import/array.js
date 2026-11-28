// @ts-check
// array.js — what a source array column becomes when `.lite` cannot type its
// elements.
//
// `.lite` holds an array of String, Int, File or an enum (`src/core/parser.js`).
// Trigger.dev writes `DateTime[]` and Lago `timestamp[]`; emitted as written,
// the parser refuses the whole schema. An array column is JSON text either way,
// so `Json` stores the same bytes and only the element type goes. Every reader
// owes this, so the rule and its sentence are said once.

const ELEMENTS = new Set(['String', 'Int', 'File'])

export const ARRAY_ELEMENT_EMITTED =
  'Json — a .lite array holds String, Int, File or an enum; the column stores the same JSON text, and its elements are no longer typed'

// `extra` is the column's attributes so far: a `@scale` on an array has no
// minor-unit reading, so a decimal array is not carried as `Int[]` either.
export function carriesArray(/** @type {string} */ type, /** @type {boolean} */ isEnum, /** @type {string[]} */ extra = []) {
  if (isEnum) return true
  return ELEMENTS.has(type) && !extra.some(a => a.startsWith('@scale'))
}
