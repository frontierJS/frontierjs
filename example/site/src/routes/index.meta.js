// site/src/routes/index.meta.js — the home page's build-time data.
//
// `load()` runs in Node at BUILD time and whatever it returns is baked into a
// public HTML file. That is the whole risk this surface exists to demonstrate,
// and it is why `db` is declared in config/sierra.config.js: Sierra taps that
// client with $tapQuery while this function runs and refuses to emit the page
// if anything read here is gated above what the route declares (nothing, so
// level 0).
//
// Try it: read `user` below and run `bun run build:site`. The build stops,
// naming the route and the model, instead of writing every user in the database
// into a file a CDN will hold for a week.
import { sys } from '../../../api/src/core/db.ts'

/** Three products for the front page, newest first, with a price range each. */
export async function load() {
  const products = await sys.product.findMany({
    where:   { active: true },
    limit:   3,
    orderBy: { createdAt: 'desc' },
  })

  const variants = await sys.productVariant.findMany({
    where: { productId: { in: products.map(p => p.id) } },
    limit: 200,
  })

  const images = await sys.productImage.findMany({
    where:   { productId: { in: products.map(p => p.id) } },
    orderBy: { position: 'asc' },
    limit:   200,
  })

  // Flattened HERE rather than in the page, because whatever this returns is
  // serialised into the HTML: shipping every variant row so the browser can
  // reduce them to a price range puts the variant table in a page that renders
  // three cards.
  return {
    products: products.map(p => {
      const own    = variants.filter(v => v.productId === p.id)
      const prices = own.map(v => v.price)
      const shot   = images.find(i => i.productId === p.id) ?? null
      return {
        name:  p.name,
        slug:  p.slug,
        brand: p.brand,
        blurb: (p.description ?? '').split('. ')[0],
        from:  prices.length ? Math.min(...prices) : null,
        to:    prices.length ? Math.max(...prices) : null,
        image: shot ? { src: shot.file, alt: shot.alt } : null,
      }
    }),
  }
}
