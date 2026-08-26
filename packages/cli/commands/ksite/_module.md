---
title: ksite
description: The ksite static-site toolchain — clone, fetch content, set up, deploy
---

**Not FrontierJS.** These commands drive `ksite`, a separate static-site
toolchain: they clone from the `kobamisites` org, mirror a canonical checkout
named by `KSITE_DIR`, and convert a sitemap into markdown under
`site/content/`.

They lived under `site:` until `site/` became a FrontierJS surface (`fli
make:site`, `fli site:dev`). One namespace cannot mean both a prerendered
Sierra surface and an unrelated toolchain, and the surface is the one an FJS
app has. The short aliases are unchanged — `fli clone`, `fli fetch` — and the
generic `fli serve` is gone, because two things now serve a directory called
`site/` and neither should answer to a bare verb.

| Command | What it does |
| --- | --- |
| `fli ksite:clone <name>` | clone a site repo into `$SITES_DIR` |
| `fli ksite:setup` | first-time setup for a fresh clone |
| `fli ksite:fetch` | sitemap/URL → markdown under `site/content/` |
| `fli ksite:update` | pull `$KSITE_DIR` and mirror framework files in |
| `fli ksite:serve` | serve `site/dist/client` |
| `fli ksite:deploy` | `npm run deploy:site` |
