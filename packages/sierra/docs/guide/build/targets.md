# Build targets

A target is what the build produces. `spa` is one client-routed bundle, `static` adds a prerendered page per route, and `widget` is an embeddable script for a page you do not own. The target is one line in the config.

```bash
vite build                                              # spa or static, from the surface's Vite root
sierra site --serve                                     # the built static site, as its own origin
sierra widgets --config config/sierra.config.js         # target: 'widget', one script per widget
```

## What else it can do

- `static` is the SPA's config plus a prerender pass, and a route that cannot be prerendered is left to the browser and listed with the reason
- A static site is its own surface, `site/`, beside `api/` and `web/`, with its own Vite root and `dist/`
- `sierra site --compile` makes the server and the built site one executable, with `--out` and `--target` to move or retarget it
- `widget` turns each `.mesa` in `src/embeds/` into one self-contained script that mounts in a shadow root
- A host page uses a widget as `<mt-counter data-start="5">` and `data-*` attributes arrive as camelCased strings
- `widgets: { dir, outDir, prefix }` says where the widgets are, where their scripts go and what tag prefix they take
- `sierra widgets --serve` serves `dist/embeds` with the CORS and cache headers a stranger's page needs

**In depth:** [README § Build targets](../../../README.md#build-targets)
