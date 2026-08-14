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
// Try it: change `product` to `user` below and run `bun run build:public`. The
// build stops naming the route, the model and what to do about it, instead of
// writing every user in the database into dist/public/catalog/index.html — run
// it, the message is the documentation. Note WHICH refusal you get: the browser
// build reads db/schema.lite from disk, and auth's four models are appended at
// startup rather than pasted in, so the message is *read `user`, which the
// schema does not describe, so its gate is unknown* rather than a level
// comparison. Fail-closed on an unknown model is the stronger half of this
// check, and it is the half that does not move when a gate does — auth's User
// went from 8 to 4 and this refusal is unchanged.
import { sys } from '../../../../api/db.ts'

export async function load() {
  const products = await sys.product.findMany({
    limit:   50,
    orderBy: { name: 'asc' },
  })
  return { products }
}
