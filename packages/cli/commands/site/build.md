---
title: site:build
description: Build the site — the bundle, then one prerendered HTML file per route
alias: site-build
examples:
  - fli site:build
---

An ordinary Vite build, and then Sierra prerenders every route declaring
`render: static` in its frontmatter into its own `index.html`.

Two things fail here and nowhere else. A route whose `load()` read data gated
above what it declares is **refused** rather than emitted — `publishes: N` in
that route's frontmatter is the override, and it is in the route snapshot so a
reviewer sees it. And a route that declares `render: static` but produces no
page — a `getStaticPaths()` that returned nothing, a `load()` that threw, a
render that failed — stops the build naming the route, rather than exiting 0
with one line among the bundler's own.

```js
context.exec({
  // `bun --bun`, not `bunx`: a static route's `load()` imports the app's own
  // Litestone client, which is TypeScript and opens `bun:sqlite` — under node
  // that is `Only URLs with a scheme in: file, data, and node are supported`,
  // reported as *could not load the db*. And `--env-file`, because this runs
  // from the surface and bun auto-loads `.env` from the working directory.
  command: 'bun --bun --env-file=../.env vite build -c config/vite.config.js',
  cwd:     context.paths.site,
  dry:     flag.dry,
})
```
