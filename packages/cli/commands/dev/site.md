---
title: dev:site
description: Start the site surface's dev server
alias: site-dev
examples:
  - fli dev:site
  - fli dev:site --port 8600
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

<script>
import { resolve } from 'path'
</script>

```js
const port = flag.port ? `SITE_PORT=${flag.port} ` : ''
const { viteCommand } = await import(resolve(global.fliRoot, 'core/scaffold/surface.js'))
$.exec({
  command: `${port}${viteCommand()}`,
  cwd:     $.paths.site,
  dry:     flag.dry,
})
```
