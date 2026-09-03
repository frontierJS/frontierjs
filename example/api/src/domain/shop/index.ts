// api/src/domain/shop/index.ts — the door into the shop.
//
// Five files, and unlike `payroll/` they are grouped by SUBJECT rather than by
// coupling: four of them import nothing from each other, and the single
// internal edge is `settle → inventory` (an order that is paid for consumes
// what was held). Saying so matters, because a door over a shelf promises a
// boundary that is not being enforced by the arrangement itself — it is
// enforced by this file and by nothing else.
//
// Two of these are credentials rather than calculations, and they are here
// because what they identify is a BASKET and an ORDER, which only a shop has:
// `cart-claim` is the header a stranger carries, read by `createApp({ principal })`,
// and `checkout-code` is the entitlement a hosted checkout link proves.

// ─── what a basket costs, and why ─────────────────────────────────────────
export { priceBasket, contextFor, discountByCode, discountProblem, money, BASE } from './pricing.ts'

// ─── the shelf: on hand, held, and the ledger every write is paired with ──
export { levelsFor, move, hold, release, consume, heldUntil, releaseExpired, HOLD_MINUTES } from './inventory.ts'
export type { MovementKind } from './inventory.ts'

// ─── an order has been paid for, or given back ────────────────────────────
export { settleOrder, refundOrder } from './settle.ts'

// ─── the two credentials a caller with no session carries ─────────────────
export { cartClaim, CART_HEADER }                    from './cart-claim.ts'
export { checkoutCodeFor, orderIdFromCheckoutCode }  from './checkout-code.ts'
