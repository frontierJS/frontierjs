---
title: site:build
description: Build the site — the bundle, then one prerendered HTML file per route
alias: site-build
examples:
  - fli site:build
  - fli site:build --binary
flags:
  binary:
    type: boolean
    description: Then compile dist/ and its server into one executable at bin/site
    defaultValue: false
---

<script>
import { existsSync } from 'fs'
import { join } from 'path'
</script>

An ordinary Vite build, and then Sierra prerenders every route declaring
`render: static` in its frontmatter into its own `index.html`.

Two things fail here and nowhere else. A route whose `load()` read data gated
above what it declares is **refused** rather than emitted — `publishes: N` in
that route's frontmatter is the override, and it is in the route snapshot so a
reviewer sees it. And a route that declares `render: static` but produces no
page — a `getStaticPaths()` that returned nothing, a `load()` that threw, a
render that failed — stops the build naming the route, rather than exiting 0
with one line among the bundler's own.

`--binary` then compiles `dist/` and the server `fli site:serve` runs into one
executable at `bin/site` — nothing installed on the machine that runs it, and
the same directory-index, cache and 404 answers. `./bin/site --port 8080`, or
`PORT`. For another OS, run
`sierra site --compile --target bun-darwin-arm64` (or `bun-windows-x64`) from
`site/`; `--dir` compiles a `dist/` something else built.

```js
// A site-kit site is content/ with no Vite config of its own, and Vite's
// answer to the missing file is an UNRESOLVED_ENTRY from rolldown.
if (!existsSync(join($.paths.site, 'config/vite.config.js'))) {
  log.error(`No config/vite.config.js in ${$.paths.site}, so this is not a site/ surface fli made.`)
  if (existsSync(join($.paths.site, 'content')))
    log.error('It holds content/, which is a site-kit site: run `site-kit build <dir> --binary` from the directory above it.')
  process.exit(1)
}

$.exec({
  // `bun --bun`, not `bunx`: a static route's `load()` imports the app's own
  // Litestone client, which is TypeScript and opens `bun:sqlite` — under node
  // that is `Only URLs with a scheme in: file, data, and node are supported`,
  // reported as *could not load the db*. And `--env-file`, because this runs
  // from the surface and bun auto-loads `.env` from the working directory.
  command: 'bun --bun --env-file=../.env vite build -c config/vite.config.js',
  cwd:     $.paths.site,
  dry:     flag.dry,
})

if (flag.binary) $.exec({
  command: `${$.bin('sierra', $.paths.site)} site --compile`,
  cwd:     $.paths.site,
  dry:     flag.dry,
})
```
