// @ts-check
// scale.js — a decimal default, restated in the minor units `@scale(n)` stores.
//
// `@scale(2)` keeps a whole number of hundredths in an INTEGER column, so the
// source's `DEFAULT 4.99` is `@default(499)` here. Written as 4.99 the parser
// refuses the schema, which is how Sakila and Pagila first failed to read.
// Every reader that emits `@scale` owes this, so it is said once.

// Shifted as text: 4.99 * 100 is 499.00000000000006 in a float. Returns null
// when the default has more places than the column keeps, and the caller
// records that rather than rounding a value the source wrote exactly.
export function toMinorUnits(/** @type {string} */ v, /** @type {number} */ places) {
  const m = v.match(/^(-?)(\d+)(?:\.(\d+))?$/)
  if (!m) return v
  const [, sign, whole, frac = ''] = m
  if (frac.replace(/0+$/, '').length > places) return null
  const n = (whole + frac.padEnd(places, '0').slice(0, places)).replace(/^0+(?=\d)/, '')
  return n === '0' ? '0' : sign + n
}

// The places an emitted attribute list declares, or null.
export const scaleOf = (/** @type {string[]} */ extra) => {
  const hit = extra.map(e => e.match(/^@scale\((\d+)\)$/)?.[1]).find(Boolean)
  return hit === undefined ? null : +hit
}
