// widgets/src/lib/shop.js — the shop's API, from a page the shop does not own.
//
// Plain `fetch`, and NOT `@frontierjs/junction`'s browser client. Two reasons,
// both about being a guest:
//
//   · **Bytes.** An embed's cost is paid by somebody else's page. The client
//     brings a WebSocket transport, a store layer and an auth surface, and this
//     widget uses none of them.
//   · **A socket on a page you do not own is a resource nobody granted you.**
//     The client opens one and keeps it open; a buy button has no business
//     holding a connection open on a stranger's blog post.
//
// What is lost by not using it is real and is the trade: no live updates, so
// the availability shown here is as of the last call. The Data boundary refuses
// an over-add regardless and says so, which is the same contract the shop's own
// buy box has with `x-gate`.
//
// ─── The basket lives in THIS origin ──────────────────────────────────────
//
// `localStorage` is per origin, so a basket started from a widget on
// example.com is not the basket on the shop's own site — they cannot see each
// other's storage and no amount of wanting changes that. Handing one over is
// `handoff`/`redeem` below, and it is deliberately not a token in a URL.

/** Per origin, and namespaced: a host page may carry two vendors' widgets. */
const STORAGE_KEY = 'fjs-shop-widget-cart'

/** One spelling, shared with api/cart-claim.ts. */
const CART_HEADER = 'x-cart-token'

export function createShop({ api }) {
  const base = String(api).replace(/\/+$/, '')

  const held = () => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') } catch { return null }
  }
  const remember = (basket) => {
    try {
      if (basket) localStorage.setItem(STORAGE_KEY, JSON.stringify(basket))
      else        localStorage.removeItem(STORAGE_KEY)
    } catch { /* private mode: the basket lasts as long as the tab */ }
  }

  /**
   * One request.
   *
   * A custom method over HTTP is `POST /{service}[/{id}]` with the name on
   * `X-Service-Method` — the same shape junction's own client sends, written
   * out because there is no client here. Both header names have to survive the
   * CORS preflight, which is why the app declares `callHeaders` and allows
   * every origin: a header the preflight does not name never arrives, and the
   * failure is a basket call that answers 404 rather than an error anywhere.
   */
  async function call(service, method, id, body, token) {
    const url = id == null ? `${base}/api/${service}` : `${base}/api/${service}/${id}`
    const res = await fetch(url, {
      method:  'POST',
      headers: {
        'content-type':     'application/json',
        'X-Service-Method': method,
        ...(token ? { [CART_HEADER]: token } : {}),
      },
      body: JSON.stringify(body ?? {}),
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) {
      // The shop's own sentence. `carts` throws with a status and junction's
      // error boundary carries the message through, so "Only 2 of FJS-TEE-CLY-L
      // left" arrives intact and this widget renders it without a code table.
      const err = new Error(data?.message ?? `The shop answered ${res.status}`)
      err.status = res.status
      throw err
    }
    return data
  }

  return {
    /** Everything a buy button shows, in one call — see product-variants.embed. */
    item: (sku) => call('product-variants', 'embed', null, { sku }),

    /** How many of this basket's items are in it, or 0 for no basket. */
    count: () => held()?.count ?? 0,

    /** Add one variant, minting a basket the first time. */
    async add(variantId, quantity = 1) {
      let basket = held()

      if (!basket?.token) {
        const opened = await call('carts', 'open', null, {})
        // Persisted BEFORE anything else: a throw after this point leaves a
        // basket that can still be reached, where a throw before it would leave
        // a row in the database nothing can ever name again.
        basket = { token: opened.token, id: opened.id, count: 0 }
        remember(basket)
      }

      const view = await call('carts', 'addLine', basket.id, { variantId, quantity }, basket.token)
      basket = { ...basket, count: view.count }
      remember(basket)
      return view
    },

    /**
     * A link that hands this basket to the shop's own site.
     *
     * The code goes in the FRAGMENT, never the query string: a fragment is not
     * sent to the server, so it is in no access log and no `Referer` header.
     * The shop's own screen redeems it and strips it from history immediately —
     * see web/src/cart.js. Even leaked it is worth one basket, for two minutes,
     * once.
     */
    async checkoutUrl(shopOrigin) {
      const basket = held()
      if (!basket?.token) return null
      const { code } = await call('carts', 'handoff', basket.id, {}, basket.token)
      return `${String(shopOrigin).replace(/\/+$/, '')}/cart/#h=${code}`
    },

    /** After a handoff the basket belongs to the shop's site, so this origin
     *  stops claiming it. Without this the widget still shows a count for a
     *  basket that has been checked out somewhere else. */
    release: () => remember(null),
  }
}
