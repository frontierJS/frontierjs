---
title: site:serve
description: Serve the built site the way a static host does
alias: site-serve
examples:
  - fli site:serve
  - fli site:serve --port 8700
flags:
  port:
    char: p
    type: string
    description: Port to serve on (8700 = dev / siteServe / project 0)
    defaultValue: '8700'
---

The same static server `site/deploy/` runs: a directory index, so `/about/`
resolves to `about/index.html`; a cache answer per file kind, so HTML is
revalidated and only hashed assets are immutable; and the site's own `404.html`
served with a 404 status.

A hand-rolled file server in a test harness forgets all three, and then the
harness proves the site works under rules nothing in production applies.

```js
context.exec({
  command: `bunx sierra site --serve --port ${flag.port || 8700}`,
  cwd:     context.paths.site,
  dry:     flag.dry,
})
```
