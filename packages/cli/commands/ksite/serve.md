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
const sitePath = path.resolve(context.paths.site, 'dist/client')
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

// Sidecar Bun script lives beside this command. It runs `Bun.serve` so the
// command works whether FLI itself is running under Node or Bun.
const sidecar = path.join(global.fliRoot, 'commands/site/serve.bun.js')

// Quick sanity check — give a useful error if `bun` isn't on PATH.
try {
  await $`command -v bun`.quiet()
} catch {
  log.error('bun is not on PATH — install Bun from https://bun.sh to use this command')
  return
}

context.exec({
  command: `bun run "${sidecar}" "${sitePath}" ${port}`,
  stdio:   'inherit',
})
```
