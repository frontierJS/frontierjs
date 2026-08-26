import { createBaseService } from '@frontierjs/junction'

// The provider's own words, as a list a person can read.
//
// Read-only by declaration and read-only by gate: `PaymentEvent` is
// @@gate("5.8.9.9") — an administrator reads, `asSystem()` writes, and update
// and delete are LOCKED, which `asSystem()` does not pass either. So there is
// nothing this service could offer beyond `find` and `get` that the Data
// boundary would let through, and naming only those two is what turns a
// pointless 403 into a 405.
//
// `model:` is stated rather than derived. `payment-events` singularises to
// `payment-event`, which resolves — but a model whose name is two words is the
// exact case where three resolvers agreeing is worth not relying on, and the
// declaration costs one line (Invariant 2).
export function createPaymentEventsService() {
  return createBaseService({
    model:   'PaymentEvent',
    methods: ['find', 'get'],
  })
}
