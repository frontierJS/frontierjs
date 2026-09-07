// What the shop took, by order state — the first REPORT surface.
//
// `FJS-D228` phase 2. This is a `view` in `db/schema.lite` and not a table: its
// `@@sql` sums every order in the shop, `@@materialized` keeps the answer, and
// `@@refreshOn([Order])` rebuilds it when one moves. Nothing here computes
// anything.
//
// **Read-only because a projection has nothing to write to.** A view's write
// verbs exist on the client and refuse by name at runtime; declaring the set
// here turns that into a 405 the router answers, which is the difference
// between a method this service does not have and an error from the database.
//
// **Its gate is the inversion worth knowing about.** `revenueByStatus` reads at
// 5 over `Order`, which reads at 1 — so a signed-in shopper who legitimately
// lists their OWN orders may not read the sum of everybody's, and staff who read
// EVERY order may not either. The projection is gated ABOVE the rows it
// aggregates, which is `FJS-970`'s point and is the whole reason a report is not
// just a screen over a query someone could have run themselves.
import { createBaseService } from '@frontierjs/junction'

export function createRevenueService() {
  return createBaseService({
    model:   'revenueByStatus',
    channel: 'revenue',
    methods: 'readOnly',
  })
}
