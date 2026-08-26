// api/cart-claim.ts — the header a shopper carries, as a claim a policy reads.
//
// A shopper is a STRANGER: no account, no session, level 0. They still have to
// be the only person who can see their own basket, and `Cart`'s policies say so
// in the schema — `@@allow('read', token == auth().cartToken)`. Something has
// to put `cartToken` on the principal for a caller who has no principal, and
// this is that something.
//
// `createApp({ principal })` is the seam, and it runs for a caller with no
// session as well as for one with a session. What it may NOT do is turn the
// claim into a session: `sessionGateLevel` grades any object it is handed, and
// a claims-only principal sets none of the standing flags while leaving
// `verifiedAt`/`activatedAt` undefined — silence, not null — so it would fall
// through to USER(4) and grade every anonymous shopper as signed in. Junction
// keeps `ctx.auth.user` null for a guest and hands the claims only to the Data
// client; the gate still says 0 and the claim decides only WHICH ROWS.
//
// ─── Why a header and not a cookie ────────────────────────────────────────
//
// A cookie is sent by the browser on every request including ones the shop did
// not make, which is what CSRF is. The token is a bearer capability over a
// basket, so it travels explicitly, on a header this app's own client sets.

import type { ServiceContext } from '@frontierjs/junction'

/** The header the browser client sends. Also the name the service answers with
 *  when it mints a basket, so there is one spelling of it. */
export const CART_HEADER = 'x-cart-token'

/**
 * A cart token is a cuid — `c` and 24 base36 characters, which is what
 * `@default(cuid())` on `Cart.token` mints. It is a bearer secret, so anything
 * shaped wrong is refused HERE rather than turned into a database query: a
 * claim is a statement about what the caller holds, and an unparseable one is
 * no claim at all. Never an empty string, which would match a row whose column
 * is blank.
 *
 * The shape is asserted rather than assumed. This regex read `uuid` while the
 * schema said `cuid()`, and the two disagreeing is not an error anywhere — the
 * claim is simply absent, the policy matches no rows, and every basket call
 * answers 404 as though the token belonged to somebody else.
 */
const LOOKS_LIKE_TOKEN = /^c[0-9a-z]{24}$/

export function cartClaim(ctx: ServiceContext, user: unknown) {
  // `ctx.headers` on a TransportContext, `ctx.client.headers` on a
  // ServiceContext — the two shapes carry headers in different places and a
  // resolver runs against whichever one made the call.
  const headers = (ctx as { headers?: Record<string, string> }).headers
                ?? ctx.client?.headers
                ?? {}

  const raw = headers[CART_HEADER] ?? headers[CART_HEADER.toUpperCase()]
  if (typeof raw !== 'string' || !LOOKS_LIKE_TOKEN.test(raw)) return {}

  // The claim is NOT proof of anything except that the caller is holding this
  // string. That is the whole security model of a bearer token and it is why
  // the policy compares against a `@guarded` column: the token is never in a
  // response, so the only way to hold one is to have been given it.
  //
  // Note what is deliberately absent — no database read. `membershipClaim`
  // verifies a membership row because a tenancy claim asserted without proof
  // scopes a stranger INTO a tenant; here the claim scopes them to exactly the
  // rows carrying the string they already have, and a token nobody issued
  // matches nothing.
  return { cartToken: raw }
}

/**
 * What this resolver is, for `junction principal`.
 *
 * A resolver is a function, so without this the committed snapshot can say only
 * that the app installs one called `cartClaim` — and *which claim it emits* is
 * the fact the schema's `@@allow('read', token == auth().cartToken)` is
 * comparing against. The two names have to agree and nothing else checks that
 * they do.
 *
 * `model` and `subject` are null and that is the substance rather than a gap:
 * this resolver reads no row. A tenancy claim asserted without proof scopes a
 * stranger into a tenant, which is why `membershipClaim` must query; a bearer
 * capability is proof by construction, and the snapshot saying `bearer` rather
 * than `membership` is the difference stated where somebody reviewing access
 * will see it.
 */
cartClaim.describe = () => ({
  kind:     'bearer',
  model:    null,
  subject:  null,
  tenant:   null,
  standing: null,
  claims:   ['cartToken'],
  include:  [],
  namedBy:  `the ${CART_HEADER} header`,
})
