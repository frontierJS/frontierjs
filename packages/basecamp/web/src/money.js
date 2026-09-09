// web/src/money.js
// Minor units on the wire, a person's own currency on the screen.
//
// One owner because there were two: `/servers/provision/` and `/cloud-spend/`
// each carried `new Intl.NumberFormat(…).format(minor / 100)` under a comment
// saying the divisor belongs to the currency. It does — `minorUnits` is what
// says so — and dividing by a hundred is right for the euro and the dollar and
// wrong for the yen by a hundred and for the dinar by a thousand. Two copies
// of a rule this repo already owns is the shape that drifts the moment a third
// screen shows a price.

import { formatMoney, minorUnits } from '@frontierjs/toolbelt/units'

/**
 * @param {number} minor     the amount in minor units, as every boundary here carries it
 * @param {string} currency  ISO 4217 — the vendor's, never assumed
 */
export function money(minor, currency) {
  if (typeof minor !== 'number' || !Number.isFinite(minor)) return ''
  const code = currency || 'USD'
  return formatMoney(minor / 10 ** minorUnits(code), code)
}
