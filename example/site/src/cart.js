// site/src/cart.js — the storefront's basket.
//
// One implementation, imported rather than copied. A basket is not a
// surface-level decision the way `money.js` is — that file exists twice on
// purpose, because a prerendered page has no reader and no storage and must
// print the shop's base currency — whereas *what is in the basket, what it
// costs and what checkout sends* is the same answer on any screen the shop
// owns. A second copy of 390 lines of token handling, discount and delivery
// arithmetic is `FJS-483`'s shape waiting to happen.
//
// It lives under `web/` for now because that is where it was written, and the
// console's basket screen is still the only caller with a drive behind it. When
// buying leaves the console this file becomes the implementation and the
// re-export flips direction — one line, in one place, either way.
import { createJunctionClient } from '@frontierjs/junction/client'
import { clientOptions }        from './api.js'
import { useCartClient }        from '../../web/src/cart.js'

export * from '../../web/src/cart.js'

/**
 * The storefront's ONE Junction client, built on first mount.
 *
 * `createJunctionClient` directly, exactly as the three reading islands here
 * already do — and NOT `@frontierjs/sierra/junction`'s singleton, which would
 * be the tidier answer on any other surface. Importing that module puts it in
 * the module graph of every island that touches a basket, and an island's graph
 * is imported by the prerender: `vite build` renders the pages it can and then
 * hangs, no error, no output, no page (`FJS-550`). The store takes its client
 * for exactly this reason.
 *
 * One client and not one per island, because a basket is shared state across
 * three mount points on two pages — three clients would be three tokens and
 * three answers to *what is in the basket*.
 *
 * **Inside a mount, never at module scope.** An island's body runs during the
 * static render too, and a client built there opens a socket from inside the
 * build. That is the same trap one layer down, and it is why every island on
 * this surface builds its client in `$.onMount`.
 */
let _client = null

export function bootShop() {
  if (!_client) {
    _client = createJunctionClient(clientOptions)
    // Wires the store AND re-applies the token this browser is holding — the
    // module above restored it at import, against a client that did not exist.
    useCartClient(() => _client)
  }
  return _client
}

export function getClient() { return bootShop() }
