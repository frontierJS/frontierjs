// web/src/money.js — what a price says, and in which currency.
//
// One owner, because there were five. `` `£${n.toFixed(2)}` `` was written out
// in the products list, the product page, the basket, the home page's Banked
// tile and the prerendered catalogue island — and the API wrote a bare
// `toFixed(2)` into two email bodies, an amount with no currency at all in the
// one place a reader is being told what they were charged. That is `FJS-408`'s
// shape exactly, one magnitude later.
//
// The formatting itself is `@frontierjs/toolbelt/units`, which is where it has
// to be: the API formats the same amounts into email and cannot import a
// `.mesa` or anything under `web/` (`FJS-D116`, boundary 2). What lives HERE is
// the part that is this app's own — which currency the shop keeps its books in,
// and which one the reader is looking at.
//
// ─── The rate is fixed, and it is not pretending otherwise ────────────────
//
// A toggle that changed only the symbol would be a lie: $28 and £28 are
// different amounts, and showing one row both ways with one number under it is
// worse than showing one currency. So the amount is converted — against a
// FIXED table, stated here, with no clock behind it and no provider. A real
// shop takes a rate from somewhere and stores which rate a given order was
// charged at, on the order; that is a feature, not a formatter, and inventing
// half of it here would make this example teach the wrong thing.

import { formatMoney } from '@frontierjs/toolbelt/units'
import { prefs }       from './prefs.js'

/** What the seed's numbers ARE. Every `price` and every `total` in the
 *  database is this currency; nothing stores a currency per row. */
export const BASE = 'USD'

/**
 * Display currencies, and what one unit of BASE is worth in each.
 *
 * A table rather than a boolean because two is not a special number — a third
 * currency should cost a line here and nothing else. `label` is what the
 * settings control shows; the symbol comes from the formatter, so nothing in
 * this app writes a currency glyph.
 */
export const CURRENCIES = [
  { code: 'USD', label: 'US dollar (USD)',       rate: 1 },
  { code: 'GBP', label: 'Pound sterling (GBP)',  rate: 0.79 },
  { code: 'EUR', label: 'Euro (EUR)',            rate: 0.92 },
]

const byCode = (code) => CURRENCIES.find(c => c.code === code) ?? CURRENCIES[0]

/** The currency the reader has chosen, defaulting to the shop's own. */
export function currency() {
  return byCode(prefs.currency ?? BASE).code
}

/**
 * A stored amount, as the string a person reads.
 *
 * Readers must still declare `$: prefs.currency` — this is a plain function and
 * Mesa decides what an expression depends on from the expression's own text, so
 * a component that only calls `money(row.price)` renders once and never moves
 * when the preference changes.
 */
export function money(amount) {
  if (amount == null || amount === '') return ''
  const c = byCode(prefs.currency ?? BASE)
  return formatMoney(Number(amount) * c.rate, c.code)
}

/**
 * The rate in force, for a screen that has to say so out loud.
 *
 * Takes a code because the settings screen asks about the choice being MADE,
 * not the one in force — a hint describing the saved preference under a control
 * showing an unsaved one is a hint that contradicts the radio beside it.
 */
export function rateNote(code = prefs.currency ?? BASE) {
  const c = byCode(code)
  return c.code === BASE
    ? `Prices are in ${BASE}, as stored — no conversion.`
    : `Converted from ${BASE} at a fixed ${c.rate}. This example has no rate provider; a real shop records the rate on the order.`
}
