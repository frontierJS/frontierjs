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

import { bearerClaim, header } from '@frontierjs/junction'

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
 * Who the caller is FOR THIS REQUEST, beyond who they are — and how a way into
 * a basket is minted. One declaration: the resolver reads the grant row this
 * mints, so the key, the purpose, the model and the column are stated here and
 * nowhere else.
 *
 * The token is read off the header, digested, and looked up — what reaches the
 * Data boundary is the BASKET'S ID, so the shopper's secret stops here
 * (`FJS-D343`). `CartGrant` declares neither `expiresAt` nor `revokedAt`, which
 * is how it says a basket's grant lives as long as the basket.
 *
 * `cartClaim.mint(system, { cartId })` takes the SYSTEM client because
 * `CartGrant` is `@@gate("8")`: a shopper never reads their own grant — they
 * hold the only half that matters — and the row is written before any
 * principal exists to be graded.
 *
 * `session: 'merge'`: the store sends the header on every call, signed in or
 * not, so a shopper who signs in mid-basket is one person still holding their
 * basket. The default would 400 every one of them (`FJS-D831`).
 */
export const cartClaim = bearerClaim({
  from:    header(CART_HEADER),
  model:   'cartGrant',
  column:  'tokenHash',
  subject: 'cartId',
  purpose: CART_PURPOSE,
  key:     cartKey,
  claims:  { cartId: 'cartId' },
  namedBy: `the ${CART_HEADER} header`,
  session: 'merge',
})
