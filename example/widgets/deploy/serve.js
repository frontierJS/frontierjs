// widgets/deploy/serve.js — the widget origin.
//
// Static files and nothing else, with the two headers an embed depends on: CORS
// (the host page is on another origin by definition) and a cache answer per file
// kind (the entry's URL was pasted into a CMS a year ago and cannot change, so
// only content-addressed assets may be immutable).
//
// The server itself is Sierra's, so what is tested locally is what runs here.

import { serveWidgets } from '@frontierjs/sierra/widget/serve'

const { url } = await serveWidgets({
  dir:  new URL('../dist/embeds', import.meta.url).pathname,
  port: Number(process.env.PORT ?? 8310),
})

console.log(`widgets serving at ${url}`)
