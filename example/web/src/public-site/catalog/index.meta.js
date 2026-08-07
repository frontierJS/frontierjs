// web/src/public-site/catalog/index.meta.js
//
// load() runs at BUILD time and whatever it returns is baked into a public
// HTML file. That is the whole risk this route exists to demonstrate.
//
// It reads through the app's real Litestone client — the same one api/app.ts
// boots from — so the gates are the real gates. Sierra taps this client with
// $tapQuery while this function runs and refuses to emit the page if anything
// it read is gated above what the route declares (nothing, so: level 0).
//
// Try it: change `product` to `user` below and run `bun run build:public`.
// User comes from authSchemaFragments() at @@gate("8") — the build stops and
// tells you which route, which model and what to do about it, instead of
// writing every user in the database into dist/public/catalog/index.html.
import { sys } from '../../../../api/db.ts'

export async function load() {
  const products = await sys.product.findMany({
    limit:   50,
    orderBy: { name: 'asc' },
  })
  return { products }
}
