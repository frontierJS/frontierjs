// site/src/routes/products/[slug].meta.js
//
// The first DYNAMIC route this repo prerenders, and the two exports are two
// different questions.
//
// `getStaticPaths()` answers WHICH pages exist. A dynamic route on a static
// target has no way to know its own URLs — there is no request to read a
// parameter from — so the build asks this, once, and emits one file per entry.
// A route declaring `render: static` with no `getStaticPaths` produces nothing,
// and the build says so by name rather than exiting 0 with an empty directory.
//
// `load({ params })` answers WHAT IS IN one page, and it is called once per
// entry with that entry's params. Its result is baked into that file.
//
// Both run through the client `db` in config/sierra.config.js names, so both
// are tapped by the publish check. `Product`, `ProductVariant` and
// `ProductImage` are all @@gate("0.4.4.5") — read at level 0 — which is why
// this page is allowed to exist without a `publishes:` line.
import { sys } from '../../../../api/src/core/db.ts'

/**
 * One page per ACTIVE product.
 *
 * `active: false` is a product the shop has retired, and a retired product must
 * not get a page: a URL that exists is a URL a search engine keeps. It also
 * means the set of pages changes between builds, which is the honest shape of a
 * catalogue — and is why the drive counts files against the database rather
 * than against a number written down here.
 */
export async function getStaticPaths() {
  const products = await sys.product.findMany({
    where:   { active: true },
    orderBy: { slug: 'asc' },
    limit:   500,
  })
  return products.map(p => ({ slug: p.slug }))
}

export async function load({ params }) {
  // findFirst, not findUnique on the id: the URL carries the SLUG, which is a
  // real column precisely so a link survives a rename.
  const product = await sys.product.findFirst({ where: { slug: params.slug } })
  if (!product) throw new Error(`no product with slug "${params.slug}"`)

  const variants = await sys.productVariant.findMany({
    where:   { productId: product.id, active: true },
    orderBy: { sku: 'asc' },
    limit:   100,
  })

  const images = await sys.productImage.findMany({
    where:   { productId: product.id },
    orderBy: { position: 'asc' },
    limit:   50,
  })

  return {
    // The id is here so the island can ask `availability` about the whole
    // product in one call. It is not a secret — a product reads at level 0 —
    // and the alternative is one request per SKU on a page with twelve.
    productId:   product.id,
    name:        product.name,
    slug:        product.slug,
    brand:       product.brand,
    description: product.description,
    // The photographs are absolute URLs into the API's own storage, which is a
    // second origin from this one. That is what a static site's images usually
    // are, and it is worth seeing here rather than hidden behind a proxy.
    images: images.map(i => ({ src: i.file, alt: i.alt })),
    variants: variants.map(v => ({
      sku:    v.sku,
      color: v.color,
      size:   v.size,
      // The price as it was AT BUILD TIME. It is a snapshot and the page says
      // so — the island below asks the shop what it is now.
      price:  v.price,
    })),
  }
}

/**
 * This page's own `<title>` and meta description.
 *
 * Called once per emitted path, with that path's params and the data `load()`
 * just returned. It exists because frontmatter is static text: without it every
 * product page carries one title, which is the single field a search result is
 * built from, and thirteen identical ones is thirteen pages a search engine has
 * no reason to tell apart.
 */
export function head({ data }) {
  const first = (data.description ?? '').split('. ')[0]
  return {
    title:       `${data.name} — FrontierJS Supply Co.`,
    description: first || `${data.name}, from FrontierJS Supply Co.`,
  }
}
