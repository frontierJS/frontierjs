import { createBaseService } from '@frontierjs/junction'

// What an order was billed for, as a list a screen can read.
//
// Read-only by declaration and read-only by gate: `OrderLine` is
// @@gate("0.8.8.8") — anyone who may read the order may read its lines, and
// only `asSystem()` writes one. `carts.checkout` is the sole writer and nothing
// edits a line afterwards, so `find` and `get` are the whole surface; naming
// only those two turns a create that would 403 at the Data boundary into a 405
// at the door.
//
// `model:` is stated rather than derived, for the reason `payment-events` gives:
// `order-lines` singularises to `order-line` and resolves, and a two-word model
// is exactly where relying on three resolvers agreeing is not worth the line it
// saves (Invariant 2).
export function createOrderLinesService() {
  return createBaseService({
    model:   'OrderLine',
    methods: ['find', 'get'],
  })
}
