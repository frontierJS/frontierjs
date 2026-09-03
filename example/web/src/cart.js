// web/src/cart.js — the basket, browser side.
//
// Not a Resource, and the difference is the point. A Resource is a model with a
// service in front of it: find it, filter it, page it, edit a row. A basket is
// one row you already own, reached by a token rather than by an id, with five
// verbs that are not CRUD — which is why `carts` declares `methods:` and
// answers 405 to everything else, and why this file is a plain store beside
// `session.js` and `prefs.js` rather than a `.mesa` in `resources/`.
//
// ─── The token ────────────────────────────────────────────────────────────
//
// `Cart.token` is `@guarded`, so no response carries it: `open` is the one call
// that ever answers one, and holding it is the whole of the proof. It goes in
// localStorage, and on every call it rides `x-cart-token`, where api/cart-claim
// turns it into `auth().cartToken` and the model's own `@@allow` decides which
// rows exist. Nothing in this file checks who is calling, because nothing in
// the browser can.
//
// `setCallHeader` is what makes that work over BOTH transports. Over HTTP it is
// an ordinary header; over the socket there are no per-call headers at all — a
// frame carries them under `meta.headers` and the server merges only the names
// the app declared in `http.callHeaders`. Set it as a fetch header by hand and
// the shop works exactly until the WebSocket connects.

import { watchProxy } from '@frontierjs/mesa/runtime'

/**
 * Where this store gets its Junction client.
 *
 * INJECTED, and it has to be. This module imported `getClient` from
 * `@frontierjs/sierra/junction` and that is correct for an SPA — the client is
 * an app-wide singleton `virtual:sierra` builds at boot — but it put sierra's
 * junction module in the import graph of anything that touches a basket. On a
 * `target: 'static'` surface a basket is touched by an ISLAND, and an island's
 * module graph is imported by the prerender pass: `vite build` renders the
 * pages it can and then hangs, with no error and no output (`FJS-550`).
 *
 * So the surface says. The SPA hands over sierra's singleton at boot; the
 * storefront hands over the client its islands already build for themselves.
 * Nothing here knows which, and the store below is the same store either way.
 */
let _clientFn = null

export function useCartClient(fn) {
  _clientFn = fn
  // The token was restored at import against a client that did not exist yet
  // wherever this is called late, which is the whole reason it is a function.
  attachToken()
}

const getClient = () => _clientFn?.() ?? null

/** One spelling, shared with api/cart-claim.ts. */
const CART_HEADER = 'x-cart-token'
const STORAGE_KEY = 'shop_cart'

/**
 * The basket, as a plain object with a stable identity.
 *
 * Readers declare `$: (cart.count, cart.lines)` and Mesa watches the PATHS —
 * the same shape `session` and `status` have. Reassigning this object would
 * notify nobody, so every write below is a field assignment.
 */
export const cart = {
  /** The row's id, once one exists. Null until the shopper adds something. */
  id:      null,
  status:  'open',
  lines:   [],
  count:   0,

  // ─── The money, all of it, all from the server ──────────────────────────
  //
  // `total` is the GRAND total — what the checkout button charges — and
  // `subtotal` is the lines. Every one of these arrives on every basket
  // response and NOTHING here derives one from another. A percentage
  // re-applied in JavaScript rounds on its own, and a screen showing a
  // breakdown that is a penny off the figure the card is charged is worse than
  // one showing no breakdown at all.
  subtotal:      0,
  discount:      0,
  discountCode:  null,
  discountLabel: null,
  shipping:      0,
  shippingLabel: null,
  tax:           0,
  taxRate:       0,
  taxLabel:      null,
  total:         0,

  /** Which rows are on the basket. Kept beside the amounts because a code that
   *  has expired since it was applied is worth 0 and must still be visible and
   *  removable — a shopper who cannot see the code they typed types it again. */
  discountId:       null,
  shippingMethodId: null,

  /** What the shop offers, loaded once. `ShippingMethod` reads at level 0, so
   *  this needs no session — which is the whole reason a guest can check out. */
  shippingOptions: [],
  /** True while a call is in flight — one flag, because the basket serialises
   *  its own writes below and two cannot overlap. */
  busy:    false,
  /** The server's own sentence, or null. A stock refusal names the SKU. */
  error:   null,
  /** The last completed order, so the confirmation screen has something to
   *  show after the basket it came from has been emptied. */
  receipt: null,
  /**
   * When this basket's stock stops being held — an ISO instant, or null for a
   * basket holding nothing.
   *
   * Answered by the server rather than read from a table: `StockReservation` is
   * `@@gate("5.8.8.8")`, so a shopper may not see the holds at all, including
   * their own. What they get is this one number, on the basket the shop built
   * for them, which is the only part of it that is any of their business.
   */
  heldUntil: null,
  /** How long a hold lasts, stated by the server so the sentence on screen and
   *  the sweep that enforces it cannot drift. */
  holdMinutes: 0,
}

/**
 * The WRITER's handle (Mesa RULE 45).
 *
 * A path watch is installed on the proxy, so a write straight to `cart.count`
 * updates the object and notifies nobody — the number is right, every screen
 * showing it is stale, and nothing reports either. `watchProxy` is cached per
 * object and idempotent, so this is the same proxy a reader's `$:` gets.
 *
 * Everything below writes through `_cart` and nothing writes through `cart`.
 */
const _cart = watchProxy(cart)

// ─── The token, restored ──────────────────────────────────────────────────
//
// The id is stored WITH the token, and it has to be: there is no lookup by
// token and there must not be one. That would be a service method answering
// *which basket does this secret belong to*, which is the question a bearer
// token should never be asked out loud — and it is not needed, because
// whoever was given the token was given the id in the same answer.

function stored() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') } catch { return null }
}

function remember(token, id) {
  try {
    if (token) localStorage.setItem(STORAGE_KEY, JSON.stringify({ token, id }))
    else       localStorage.removeItem(STORAGE_KEY)
  } catch { /* private mode: the basket lasts as long as the tab */ }
  getClient()?.setCallHeader(CART_HEADER, token ?? null)
}

/**
 * Put the stored token back on the client.
 *
 * Called at import below, which is right for an SPA: `virtual:sierra` has
 * already run `initJunction`, so the header is on the very first call —
 * including the refresh that restores a basket left open in another tab.
 *
 * It is EXPORTED for the surface where that is not true. A prerendered site has
 * no boot at all — `main.js` is in none of the built output — so its client
 * cannot exist when this module is imported, and the call below is a no-op
 * against `null`. That surface builds its client inside a mount and calls this
 * immediately after. Idempotent, and safe to call with no client.
 *
 * Getting it wrong is silent in the worst way: every basket call goes out with
 * no token, `Cart` is reached by an `@@allow` on that token, and a policy
 * FILTERS rather than refuses — so the shopper is shown an empty basket with a
 * 200 and the one they own is still sitting there.
 */
export function attachToken() {
  const held = stored()
  if (!held?.token) return null
  getClient()?.setCallHeader(CART_HEADER, held.token)
  if (_cart.id == null) _cart.id = held.id ?? null
  return held.token
}

attachToken()

/** The client, or a sentence naming the wiring that is missing. Two of the four
 *  uses below cannot degrade — a basket call with no client is not a basket. */
function required() {
  const c = getClient()
  if (!c) throw new Error(
    'The basket has no Junction client. Call useCartClient() at boot — ' +
    'web/src/main.js does it for the SPA, site/src/cart.js for the storefront.')
  return c
}

const service = () => required().service('carts')

// ─── Writes ───────────────────────────────────────────────────────────────
//
// Every verb ends by adopting the whole basket the server answered, rather than
// patching what it thinks changed. `addLine` on a variant already in the basket
// is a QUANTITY change and not a second line, and a browser guessing otherwise
// would show two rows until the next reload.

function adopt(basket) {
  _cart.id          = basket.id
  _cart.status      = basket.status
  _cart.lines       = basket.lines ?? []
  _cart.count       = basket.count ?? 0

  // Ten figures adopted whole. Written one by one rather than by spreading the
  // response, because `cart` is watched by PATH: a reader declares
  // `$: (cart.total)` and only an assignment to that path notifies it.
  _cart.subtotal      = basket.subtotal      ?? 0
  _cart.discount      = basket.discount      ?? 0
  _cart.discountCode  = basket.discountCode  ?? null
  _cart.discountLabel = basket.discountLabel ?? null
  _cart.shipping      = basket.shipping      ?? 0
  _cart.shippingLabel = basket.shippingLabel ?? null
  _cart.tax           = basket.tax           ?? 0
  _cart.taxRate       = basket.taxRate       ?? 0
  _cart.taxLabel      = basket.taxLabel      ?? null
  _cart.total         = basket.total         ?? 0

  _cart.discountId       = basket.discountId       ?? null
  _cart.shippingMethodId = basket.shippingMethodId ?? null

  _cart.heldUntil   = basket.heldUntil ?? null
  _cart.holdMinutes = basket.holdMinutes ?? _cart.holdMinutes
  _cart.error       = null
  return basket
}

/**
 * Serialise the calls.
 *
 * Two add-to-cart clicks in the same tick would both find no basket and both
 * mint one, and the second token would overwrite the first — leaving a paid-for
 * line in a basket nothing can reach. A promise chain is enough: this is one
 * shopper in one tab, not a lock.
 */
let queue = Promise.resolve()

function run(fn) {
  const next = queue.then(async () => {
    _cart.busy  = true
    _cart.error = null
    try {
      return await fn()
    } catch (err) {
      // The server's words. `carts` throws with a status and junction's error
      // boundary carries the message through, so "FJS-TEE-OLV-S is sold out"
      // arrives intact and a screen can render it without a table of codes.
      _cart.error = err?.message ?? 'Something went wrong'
      throw err
    } finally {
      _cart.busy = false
    }
  })
  // The chain must survive a rejection or every later call is dead; the caller
  // still sees the throw through `next`.
  queue = next.catch(() => {})
  return next
}

/** The basket's id, minting one if this shopper has never had a basket. */
async function ensure() {
  if (cart.id && cart.status === 'open') return cart.id

  const basket = await service().invoke('open', null)
  // The one moment a token exists in the browser. Persist it BEFORE adopting
  // the basket: a throw after adoption would leave a screen showing a basket
  // whose token was never written down.
  remember(basket.token, basket.id)
  adopt(basket)
  return cart.id
}

/** Load whatever basket this browser is holding a token for. */
export async function refresh() {
  const held = stored()
  if (!held?.token || !held.id) return null

  return run(async () => {
    try {
      return adopt(await service().get(held.id))
    } catch (err) {
      // 404 is the ordinary answer for a basket that was checked out, or one
      // whose token belongs to a database that has since been reseeded. Both
      // mean the same thing to a shopper — there is no basket — and neither is
      // an error worth showing.
      if (err?.code === 404) { clear(); return null }
      throw err
    }
  })
}

/**
 * Take over a basket handed to this origin by a widget.
 *
 * An embeddable buy button runs on a page the shop does not own, so its basket
 * token is in THAT origin's `localStorage` and nothing here can read it. What
 * crosses is a one-time code — `carts.handoff` mints it, this redeems it — and
 * the code arrives in the URL FRAGMENT, which is never sent to a server and
 * appears in no `Referer` and no access log.
 *
 * Three things happen here and each is deliberate:
 *
 *   · the code is exchanged for the token, which is what this origin then holds
 *   · the fragment is stripped from history immediately, so a shopper who
 *     shares the URL or hits back is not passing anything on. The code is
 *     already spent by then — `redeem` clears it in the same transaction that
 *     reads it — so this is the second lock rather than the first
 *   · an existing basket on this origin is REPLACED. Merging two baskets is a
 *     real feature with real questions in it (which price wins for a line in
 *     both?) and guessing is worse than the rule being stated
 *
 * Answers the basket, or null when there was no code to redeem.
 */
export function redeemHandoff(code) {
  if (!code) return Promise.resolve(null)

  return run(async () => {
    const basket = await service().invoke('redeem', null, { code })
    remember(basket.token, basket.id)
    return adopt(basket)
  })
}

/** The code in `#h=…`, if this navigation carries one. Read and then erased by
 *  the caller — see the note in `redeemHandoff`. */
export function handoffCodeFromUrl() {
  const hash = String(location.hash ?? '').replace(/^#/, '')
  return new URLSearchParams(hash).get('h')
}

export function add(variantId, quantity = 1) {
  return run(async () => {
    const id = await ensure()
    return adopt(await service().invoke('addLine', id, { variantId, quantity }))
  })
}

/**
 * Put a code on the basket.
 *
 * Sends a STRING and adopts a basket. The amount never travels in either
 * direction — what a code is worth is a function of this basket at this
 * instant, and a browser that could state it could state the total.
 *
 * A bad code throws the shop's own sentence (`api/src/domain/shop`
 * `discountProblem`), which `run` puts on `cart.error`. That is the same
 * sentence the checkout will use if the code stops being valid between now and
 * then — one rule, told twice, in the same words.
 */
export function applyDiscount(code) {
  return run(async () => {
    const id = await ensure()
    return adopt(await service().invoke('applyDiscount', id, { code }))
  })
}

export function removeDiscount() {
  return run(async () =>
    adopt(await service().invoke('removeDiscount', cart.id)))
}

/** Choose a delivery method, or pass null to go back to undecided — which is a
 *  real choice and is why there is no separate clear. */
export function setShipping(shippingMethodId) {
  return run(async () => {
    const id = await ensure()
    return adopt(await service().invoke('setShipping', id, { shippingMethodId }))
  })
}

/**
 * What the shop offers, for the picker.
 *
 * An ordinary CRUD read of a public table — `ShippingMethod` is
 * `@@gate("0.5.5.5")` — so it works with no session and no basket, which is
 * what lets the options render before a shopper has added anything.
 */
export async function loadShippingOptions() {
  if (cart.shippingOptions.length) return cart.shippingOptions
  const rows = await required().service('shipping-methods')
    .find({ active: true }, { orderBy: 'position', limit: 20 })
  _cart.shippingOptions = rows?.data ?? rows ?? []
  return cart.shippingOptions
}

export function setQuantity(lineId, quantity) {
  return run(async () =>
    adopt(await service().invoke('setQuantity', cart.id, { lineId, quantity })))
}

export function remove(lineId) {
  return run(async () =>
    adopt(await service().invoke('removeLine', cart.id, { lineId })))
}

/**
 * Turn the basket into an order.
 *
 * `details` is validated by the SEED — `carts` declares
 * `{ method: 'checkout', input: 'CheckoutDetails' }`, so a bad email comes back
 * as a 400 carrying the schema's own wording, keyed by field, which
 * `resource.fieldErrors`-shaped rendering in <Form> puts under the right box.
 */
export function checkout(details) {
  return run(async () => {
    const receipt = await service().invoke('checkout', cart.id, details)
    // The basket is gone the moment the order exists — the row is `ordered`
    // and every method refuses it — so the token is dropped here rather than
    // being left to fail on the next call.
    clear()
    _cart.receipt = receipt
    return receipt
  })
}

/** Drop the receipt — the shopper has read it and is moving on. A component
 *  must not write `cart.receipt` itself: the writes are the store's, through
 *  the proxy, or the screen showing it does not update. */
export function dismissReceipt() {
  _cart.receipt = null
}

/** Forget the basket entirely. Not an operation a shopper asks for; it is what
 *  a checkout and a stale token both end in. */
export function clear() {
  remember(null)
  _cart.id        = null
  _cart.status    = 'open'
  _cart.lines     = []
  _cart.count     = 0
  _cart.subtotal      = 0
  _cart.discount      = 0
  _cart.discountCode  = null
  _cart.discountLabel = null
  _cart.shipping      = 0
  _cart.shippingLabel = null
  _cart.tax           = 0
  _cart.taxRate       = 0
  _cart.taxLabel      = null
  _cart.total         = 0
  _cart.discountId       = null
  _cart.shippingMethodId = null
  _cart.heldUntil = null
}
