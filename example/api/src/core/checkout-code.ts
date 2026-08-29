// api/src/core/checkout-code.ts — the credential a checkout link carries.
//
// ─── What it is for ───────────────────────────────────────────────────────
//
// A hosted checkout is reached by a shopper with NO session. `Order` reads at
// VISITOR(1) behind two policies — staff, or the shopper it belongs to — so at
// that moment there is nobody for either rule to admit, and `payments.start`
// had to look the order up as the shop for whatever id arrived.
//
// An order id is a sequential integer. The money could never be redirected and
// the row could never be read, but the answer carried the order's TOTAL and the
// refusal named its STATUS — so counting from 1 was an existence, amount and
// status oracle over the whole ledger (`FJS-497`).
//
// The id says WHICH order. This says the caller is entitled to pay it.
//
// ─── Derived, not stored, and that is a choice worth reading ──────────────
//
// `Cart.handoffCode` is a stored random column and is the obvious model to
// copy. Three things argue the other way here:
//
//   · **There is no state to keep.** A handoff is consumed — minted, spent,
//     cleared — so it has a lifecycle a column has to hold. This is not: a
//     declined card is expected to be retried, so the code has to keep working
//     for as long as the order is payable, and `Order.status` already says when
//     that stops. A column would record a fact `status` already holds.
//
//   · **There is nothing to leak or to miss.** No column means no value in a
//     read to strip, no filter to probe it through, and no row that could be
//     created without one — a stored column with a client-generated default is
//     an N-1 release away from a NULL, and an order nobody can pay.
//
//   · It cost a migration, a `@unique` index and a release pivot to store four
//     bytes of entropy that `orderId` and a secret already determine.
//
// The price, stated rather than discovered: a derived code cannot be revoked on
// its own, and rotating the secret invalidates every link outstanding. Both are
// acceptable because the order's own state machine is what ends a code's life —
// `payments.start` refuses an order that is not `pending`, so a paid order's
// link is already worthless.
//
// (A stored column WAS built first and reverted. `@guarded` + a generated
// `@default()` makes a model uncreatable by any non-system caller: litestone
// grades the guard against the payload AFTER it injects its own default, so the
// column refuses its own stamp. Deliberate and fail-closed, and a real gap —
// filed as `FJS-565`.)

import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Anything that can mint a code can mint one for every order in the shop, so
 * this is the same tier of secret as the session key.
 */
const SECRET = process.env.SHOP_CHECKOUT_SECRET ?? 'dev-checkout-secret'

if (!process.env.SHOP_CHECKOUT_SECRET) {
  console.warn(
    '[example] SHOP_CHECKOUT_SECRET not set — using a fixed development value.\n' +
    '          Fine here; never anywhere real. Generate one with: openssl rand -hex 32'
  )
}

/**
 * The code for an order.
 *
 * `<orderId>.<mac>`, so the token names its own order and a caller sends one
 * opaque string rather than an id and a signature that have to agree. 128 bits
 * of the MAC, which is what `Cart.handoffCode` spends on the same job.
 */
export function checkoutCodeFor(orderId: number): string {
  const mac = createHmac('sha256', SECRET).update(`order:${orderId}`).digest('hex')
  return `${orderId}.${mac.slice(0, 32)}`
}

/**
 * Which order this code is for, or `null`.
 *
 * `null` for every way of being wrong — malformed, wrong order, wrong secret —
 * because the caller of this function answers one sentence for all of them.
 * Saying which would put the oracle back.
 *
 * Compared with `timingSafeEqual`. A code is a bearer credential and string
 * equality on one is a byte-at-a-time oracle; the lengths are fixed by
 * construction here, and unequal ones are refused before the compare because
 * `timingSafeEqual` throws on a length mismatch.
 */
export function orderIdFromCheckoutCode(code: unknown): number | null {
  if (typeof code !== 'string') return null

  const dot = code.indexOf('.')
  if (dot <= 0) return null

  const id = Number(code.slice(0, dot))
  if (!Number.isInteger(id) || id <= 0) return null

  const given    = Buffer.from(code.slice(dot + 1), 'utf8')
  const expected = Buffer.from(checkoutCodeFor(id).slice(String(id).length + 1), 'utf8')

  if (given.length !== expected.length) return null
  return timingSafeEqual(given, expected) ? id : null
}
