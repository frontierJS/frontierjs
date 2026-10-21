// site/src/stock.js — what the storefront says about a shelf.
//
// One owner for the sentence, because the availability table and the buy box
// sit on one page and read one answer. Sold out and held are different
// sentences: held comes back on its own when the basket's hold lapses, gone
// does not, and telling a shopper "sold out" about stock in somebody else's
// basket loses a customer the shop did not have to lose.

/** The sentence for a row of `product-variants.availability`. */
export function stockText(row) {
  if (row.available > 0) return `${row.available} available`
  return row.onHand > 0 ? 'In other baskets right now' : 'Sold out'
}

/** How long a page showing held stock waits before asking the shop again. */
export const HOLD_REASK_MS = 60_000

/**
 * When to ask `availability` again, or null. A hold frees itself without any
 * request arriving, so the page that read it is stale at the moment the
 * basket lapses and nothing tells the page; it has to ask. With nothing held
 * there is no lapse to wait for.
 */
export function reaskDelay(rows) {
  return rows.some(r => r.onHand > r.available) ? HOLD_REASK_MS : null
}
