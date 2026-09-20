// api/src/domain/shop/cart-grant.ts — the way into a basket somebody is holding.
//
// A shopper is a STRANGER: no account, no session, level 0. They still have to
// be the only person who can see their own basket, and `Cart`'s policies say so
// in the schema — `@@allow('read', id == auth().cartId)`. Something has to put
// `cartId` on the principal for a caller who has no principal, and `bearerClaim`
// is that something; what lives here is the half that is this shop's: which
// header carries the token, what the digest is separated by, and how a grant is
// minted.
//
// The token itself is never stored. `CartGrant.tokenHash` holds
// `fingerprint(token, { key, purpose })`, so a copy of that table is not a set
// of live baskets — and what crosses the Data boundary is the basket's ID,
// which means no query, log line or error in the shop has a secret in it.
//
// ─── Why a header and not a cookie ────────────────────────────────────────
//
// A cookie is sent by the browser on every request including ones the shop did
// not make, which is what CSRF is. This token is a bearer capability over a
// basket carried by the shop's own client, so it travels explicitly. The portal
// shape in `IDEAS/bearer-access.md` redeems its link for a cookie instead
// (`FJS-D340`) because there the link arrives in an email and must not stay in
// a URL; a basket's token is never in one.

import { fingerprint } from '@frontierjs/toolbelt/bearer'
import { generateCuid } from '@frontierjs/toolbelt/ids'

/** The header the browser client sends. Also what `carts.open` answers with,
 *  so there is one spelling of it. */
export const CART_HEADER = 'x-cart-token'

/** Domain separation for the digest. `bearerClaim` defaults to exactly this
 *  string; it is named here because the minter has to agree with the reader and
 *  a default agreed by coincidence is the kind that drifts. */
export const CART_PURPOSE = 'cartGrant.tokenHash'

/** The secret the digests are keyed on. An exfiltrated `CartGrant` table is
 *  useless without it, which is the whole reason the column is a digest and not
 *  a hash of nothing. Shares the app's key: this shop has one secret. */
export const cartKey = () => process.env.ENCRYPTION_KEY ?? 'dev-encryption-key-change-me-0001'

/**
 * Mint a way into a basket and answer the token, which is the only moment it
 * exists outside the holder's browser.
 *
 * Takes the SYSTEM client because `CartGrant` is `@@gate("8")`: a shopper never
 * reads their own grant — they hold the only half that matters — and the row is
 * written before any principal exists to be graded.
 */
export async function mintCartGrant(
  system: { cartGrant: { create: (a: { data: Record<string, unknown> }) => Promise<unknown> } },
  cartId: number,
): Promise<string> {
  // A cuid for the same reason every id here is one: minted without a round
  // trip, sortable enough to page, and wide enough that guessing is not a
  // strategy. The SHAPE is not asserted anywhere downstream — a token that
  // does not match a stored digest is simply not a grant, which is the only
  // answer a bearer may have.
  const token = generateCuid()
  await system.cartGrant.create({
    data: { cartId, tokenHash: await fingerprint(token, { key: cartKey(), purpose: CART_PURPOSE }) },
  })
  return token
}
