---
title: site:dev
description: Start the site surface's dev server
alias: site-dev
examples:
  - fli site:dev
  - fli site:dev --port 8600
flags:
  port:
    char: p
    type: string
    description: Override the dev port (8600 = dev / siteDev / project 0)
    defaultValue: ''
---

The writing loop: routes served as a client-routed app against
`site/index.html`, so markup can be iterated on without a build.

What SHIPS is the build. A `load()` runs at build time and its result is baked
into a file; the publish check that compares what it read against the schema's
gates, the island chunks and the one-file-per-route output are all
`fli site:build`. A page that works here and fails there is the normal case,
not a surprise.

```js
const port = flag.port ? `SITE_PORT=${flag.port} ` : ''
context.exec({
  // `bun --bun` and the app's own `.env` — same reasons as site:build, and the
  // dev server needs the first one too because it RUNS a static route's loader.
  command: `${port}bun --bun --env-file=../.env vite -c config/vite.config.js`,
  cwd:     context.paths.site,
  dry:     flag.dry,
})
```
