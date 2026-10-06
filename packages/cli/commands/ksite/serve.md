---
title: ksite:serve
description: Serve the built site from dist/client/ using Bun.serve (no install needed)
alias: ksite-serve
examples:
  - fli serve
  - fli ksite:serve --port 5000
flags:
  port:
    char: p
    type: number
    description: Port to serve on
    defaultValue: 3000
---

Serves the built static site at `site/dist/client/` over HTTP using `Bun.serve`.

This command spawns a sidecar Bun process (`serve.bun.js` next to this file) so
the actual serving runs under Bun regardless of which runtime is hosting FLI
itself. No external package install needed — content types are inferred from
file extensions by `Bun.file()`.

Routing:
- `/path` → tries `path` (direct file), then `path/index.html`, then `path.html`
- `/`     → `index.html`
- Returns the site's `404.html` on miss if present, otherwise plain text 404

```js
const sitePath = path.resolve($.paths.site, 'dist/client')
const port     = flag.port

if (!fs.existsSync(sitePath)) {
  log.error(`Built site not found: ${sitePath}`)
  log.info('  Run `fli ksite:build` first')
  return
}

if (flag.dry) {
  log.dry(`Would serve ${sitePath} on http://localhost:${port}`)
  return
}

// The server is a sidecar script beside this command, run by the bun that is
// running fli, so a second bun on PATH is never the one serving.
const sidecar = path.join(global.fliRoot, 'commands/ksite/serve.bun.js')

$.exec({
  command: `${JSON.stringify(process.execPath)} run "${sidecar}" "${sitePath}" ${port}`,
  stdio:   'inherit',
})
```
