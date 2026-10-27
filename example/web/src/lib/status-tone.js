// web/src/lib/status-tone.js — which tone a state gets.
//
// The STATES come from the schema — `@@transitions` on `Order`, an enum on
// `Invoice`, `Subscription` and `PayRun` — and nothing here invents one. What
// is not in the schema is whether a state is good news, and it cannot be:
// `refunded` is a failure to a shop and a relief to a customer, and no
// attribute on a column decides that.
//
// One map, keyed by the word, because copies keyed the same drifted apart:
// `paid` was `info` on the orders table and `success` on the invoices one, so
// the same word was two colours a click apart. `cancelled` is shared by
// `Order` and `Subscription` and reads one way on both.
export const TONES = {
  // Order
  pending:    'warning',
  paid:       'success',
  shipped:    'success',
  refunded:   'muted',
  cancelled:  'danger',
  // Invoice
  draft:      'muted',
  issued:     'warning',
  void:       'muted',
  // Subscription
  trialing:   'info',
  active:     'success',
  pastDue:    'warning',
  // PayRun
  calculated: 'info',
  approved:   'warning',
}

/** A tone, or `muted` for a state nobody has an opinion about yet. A missing
 *  entry is not an error — a schema may declare a state before anyone decides
 *  what it means, and a grey pill is the honest answer until they do. */
export const toneFor = (state) => TONES[state] ?? 'muted'
