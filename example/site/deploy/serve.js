// site/deploy/serve.js — the storefront origin.
//
// Static files and nothing else. Most real deployments of a site like this are
// a bucket behind a CDN and never run this file; it exists so the same answers
// can be had locally, in a container, and in the drive — which is the only way
// a header is tested at all.
//
// The server is Sierra's, so what `bun run serve:site` answers is what ships.

import { serveSite } from '@frontierjs/sierra/site/serve'

const { url } = await serveSite({
  dir:  new URL('../dist', import.meta.url).pathname,
  // `notFound` is left at its default, `404.html`: the route is emitted at
  // `404/index.html` and Sierra's postbuild copies it to the name every static
  // host looks for.
  port: Number(process.env.PORT ?? 8710),
})

console.log(`storefront serving at ${url}`)
