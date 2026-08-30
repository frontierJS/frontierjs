// site/src/money.js — what a price says on the storefront.
//
// The shop's BASE currency and nothing else, which is the whole difference from
// `web/src/money.js`. That file converts against a fixed table and reads the
// reader's saved preference out of localStorage; neither exists here. A
// prerendered page is written once, at build time, with no reader and no
// storage — and what belongs in a file a CDN serves to a stranger and to a
// crawler is the currency the shop keeps its books in.
//
// The formatting is `@frontierjs/toolbelt/units`, which is where it has to be:
// three surfaces and the API all format the same amounts, and `formatMoney` is
// `Intl.NumberFormat` rather than a symbol table because what separates two
// currencies is how many decimals the currency HAS (`FJS-440`).
//
// `BASE` is stated in two surfaces, and that is the smallest honest duplication
// available: a surface may not import another surface's `src/` (Invariant 3),
// and the real fix is the shop's own currency being a row in the Data realm
// rather than a constant in the UI — which is a feature, not a formatter.
import { formatMoney, fromMinor } from '@frontierjs/toolbelt/units'

/** What the seed's numbers ARE. Every `price` in the database is this, and
 *  every one of them is a whole number of MINOR units — the columns are
 *  `@money(USD)`. */
export const BASE = 'USD'

/** A stored amount — cents — as the string a person reads. `fromMinor` and not
 *  `/ 100`: the divisor is the currency's, and this file is the only place on
 *  this surface that applies it. */
export function money(cents) {
  if (cents == null || cents === '') return ''
  return formatMoney(fromMinor(cents, BASE), BASE)
}

/** A price RANGE, for a product family whose variants disagree. */
export function priceRange(from, to) {
  if (from == null) return '—'
  return from === to ? money(from) : `${money(from)}–${money(to)}`
}
