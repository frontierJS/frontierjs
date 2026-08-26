// The codes a shopper types at the till.
//
// The whole of its access is `@@gate("5.5.5.5")` in the seed, and that gate is
// the only staff-only READ in this app — every other table a shopper interacts
// with is public, because a storefront has to list it. Listing discount codes
// is the exploit rather than the feature: `GET /api/discounts` answering the
// table hands every unreleased code to whoever asks.
//
// So there is no shopper-facing method here at all. A basket applies a code
// through `carts.applyDiscount`, which validates it through the system client
// and answers what it is worth to THAT basket — the only fact about a code a
// shopper is entitled to.
import { createBaseService } from '@frontierjs/junction'

export function createDiscountsService() {
  return createBaseService({ model: 'Discount', channel: 'discounts' })
}
