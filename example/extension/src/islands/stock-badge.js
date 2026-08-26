// A content script on the shop's own storefront: what staff can see and a
// customer cannot.
//
// The storefront is PRERENDERED — one HTML file per product, built ahead of
// time, and the stock number is deliberately not in it. This island is the
// shop's staff looking at their own public site and seeing the shelf behind it.
//
// It holds no connection. `props.harbor` is the port to the service worker, and
// `createResource` here is the same orchestrator the dock uses — one socket, in
// the one context that outlives both surfaces.
//
// Islands are FLAT files in src/islands/ and are built in LIB MODE, which is
// not cosmetic: Vite injects a preload helper written with `import.meta` into
// any client build that is not a lib, and an MV3 content script is a CLASSIC
// script — V8 rejects the whole bundle at parse time, before a line of it runs
// (`FJS-030`).

import { defineIsland }   from '@frontierjs/jetty'
import { createResource } from '@frontierjs/jetty/resources'

/** `/products/explorer-tee/` → `explorer-tee`; anything else → null. */
export function slugFromPath(pathname) {
  const m = /^\/products\/([^/]+)\/?$/.exec(pathname)
  return m ? m[1] : null
}

export default defineIsland({
  position: 'fixed-bottom-right',

  app(root, props) {
    const box = document.createElement('div')
    box.setAttribute('data-shop-desk', 'stock')
    box.style.cssText = `
      background: #12232e; color: #fff; padding: 8px 12px; border-radius: 6px;
      font: 12px/1.4 system-ui, sans-serif; box-shadow: 0 4px 14px rgba(0,0,0,.25);
    `
    const label = document.createElement('div')
    label.textContent = 'Shop Desk'
    label.style.cssText = 'font-weight: 600; letter-spacing: .02em;'

    const value = document.createElement('div')
    value.setAttribute('data-stock', '')
    value.textContent = '…'
    value.style.cssText = 'color: #b9d6e8;'

    box.append(label, value)
    root.appendChild(box)

    const slug = slugFromPath(location.pathname)
    if (!slug) { value.textContent = 'no product here'; return }
    if (!props.harbor) { value.textContent = 'no harbor'; return }

    // Two services, one port. The badge is the SUM across variants, because a
    // product is the family and stock is counted on the thing with a price.
    // The model is stated for the second one and not the first. A service name
    // is a URL segment, so it is kebab-case, and `product-variants` inflects to
    // nothing the schema declares — the miss is a console warning and a bare
    // `make()`, which is a screen that renders and validates against nothing.
    const products = createResource('products')
    const variants = createResource('product-variants', { model: 'ProductVariant' })

    ;(async () => {
      try {
        const found = await products.service.find({ slug })
        const rows  = Array.isArray(found) ? found : (found?.data ?? [])
        const product = rows[0]
        if (!product) { value.textContent = 'not in the catalogue'; return }

        const vs   = await variants.service.find({ productId: product.id })
        const list = Array.isArray(vs) ? vs : (vs?.data ?? [])
        const on   = list.reduce((n, v) => n + (v.stock ?? 0), 0)
        value.textContent = `${on} on the shelf · ${list.length} variants`
      } catch (e) {
        value.textContent = `error: ${e?.message ?? e}`
      }
    })()
  },
})
