// site/src/routes/catalog/index.meta.js
//
// load() runs at BUILD time and whatever it returns is baked into a public
// HTML file. That is the whole risk this route exists to demonstrate.
//
// It reads through the app's real Litestone client — the same one api/src/app.ts
// boots from — so the gates are the real gates. Sierra taps this client with
// $tapQuery while this function runs and refuses to emit the page if anything
// it read is gated above what the route declares (nothing, so: level 0).
//
// Try it: change `product` to `user` below and run `bun run build:site`. The
// build stops naming the route, the model and what to do about it, instead of
// writing every user in the database into site/dist/catalog/index.html — run
// it, the message is the documentation. Note WHICH refusal you get: the browser
// build reads db/schema.lite from disk, and auth's four models are appended at
// startup rather than pasted in, so the message is *read `user`, which the
// schema does not describe, so its gate is unknown* rather than a level
// comparison. Fail-closed on an unknown model is the stronger half of this
// check, and it is the half that does not move when a gate does — auth's User
// went from 8 to 4 and this refusal is unchanged.
import { sys } from '../../../../api/src/core/db.ts'

export async function load() {
  const products = await sys.product.findMany({
    where:   { active: true },
    limit:   50,
    orderBy: { name: 'asc' },
  })

  // A price is on the VARIANT, so a catalogue page that shows one has to read
  // both. Both are @@gate("0.4.4.5") — read at 0 — so the publish check passes
  // for the same reason `product` alone did; adding a model to this function is
  // exactly the moment that check earns its place.
  const variants = await sys.productVariant.findMany({
    limit:   500,
    orderBy: { sku: 'asc' },
  })

  // Flattened HERE rather than in the island, because whatever this returns is
  // serialised into the page: shipping 43 variant rows so the browser can
  // reduce them to a price range puts the whole variant table in the HTML of a
  // page that renders 13 lines.
  const rows = products.map(p => {
    const own = variants.filter(v => v.productId === p.id)
    const ps  = own.map(v => v.price)
    return {
      id:      p.id,
      name:    p.name,
      slug:    p.slug,
      brand:   p.brand,
      skus:    own.map(v => v.sku),
      from:    ps.length ? Math.min(...ps) : null,
      to:      ps.length ? Math.max(...ps) : null,
      inStock: own.reduce((n, v) => n + v.stock, 0),
    }
  })

  return { products: rows }
}
