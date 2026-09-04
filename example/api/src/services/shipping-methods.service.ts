// What the shop charges to send it.
//
// `@@gate("0.5.5.5")` — read by anybody, written by staff. The storefront and
// the basket screen both list these to a caller with no session, which is the
// difference from `discounts`: one table is public and its neighbor is not,
// on the same screen, and the gate is the only thing that says so.
//
// A merchant's ordering is a column (`position`) rather than the list being
// sorted alphabetically here, because which option sits at the top decides what
// most people pick.
import { createBaseService } from '@frontierjs/junction'

export function createShippingMethodsService() {
  return createBaseService({ model: 'ShippingMethod', channel: 'shipping-methods' })
}
