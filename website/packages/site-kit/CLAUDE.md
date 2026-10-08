# site-kit — package map

**`@frontierjs/site-kit`** — the engine of a markdown-authored static site. A
site is `content/` over this package; everything a site would otherwise copy
lives here.

**Private on purpose.** It is in no list — not the website's package pages
(they walk `packages/*` and skip `private`), not npm. It is a workspace member
through the root `website/packages/*` glob, which is the only thing that
installs it; a package under `website/packages/` outside that glob is
uninstalled and says nothing.

**Two consumers, one engine.** `website/site/`, and `fjs-prototypes/ksite`,
which names `@kobami/ksite` as its preset. A generic piece here and a ksite fork of
it is the outcome this package exists to prevent.

## Layout

A site is a directory holding `content/` and nothing else; `site-kit
dev|build|preview <dir>` runs it. The site directory stays the Vite root, so
`dist/` lands beside `content/` and Sierra's root-relative paths keep meaning
what they mean in any app.

- `bin/site-kit.js` — the command. Bun, because the prerender imports each
  route's companion under the running runtime. It runs the SITE's vite, its
  peer: from a linked site-kit a bare import finds the workspace's copy, and
  Vite looks for a preset's `sass` beside its own (FJS-2026).
- `config/vite.js` — `siteKit({ root, port, host })`, the whole Vite + Sierra config.
  Owns `target`, `routesDir: 'content/routes'`, `outDir`, `trailingSlash`, and
  the route table's home in `<site>/.sierra/` (never `node_modules/`, which
  the browser caches `immutable`); the site's
  `content/settings/site.js` default export is spread over it, and is also
  `_configPath`, the file the browser imports whole (FJS-1544) — so it stays
  plain data. Without one, `_configPath` is `config/no-settings.js` (`{}`);
  unnamed, Sierra would look for `config/sierra.config.js` (FJS-1709). Order:
  site-kit's keys, then the preset's `sierra`, then the site's, then
  `routesDir` and `_configPath`, which neither a preset nor a site can move.
- `config/preset.js` — `loadPreset(name, site)`: the default export's `preset`
  key names a package whose `./preset` export returns `{ sierra, plugins,
  shell }` (FJS-D648). It resolves from the site, and every way of failing to
  load one stops the build by name, because a site built without its preset
  ships every page without its blocks.
- `config/shell.js` — `siteShell({ html, entry })`, the kit's own pair or a
  preset's `shell`. Serves `index.html` for a site whose root has none: a dev
  middleware for HTML requests, and a `load` of the root's `index.html` id in the
  build, so it emits as `dist/index.html`, the file the prerender reads. Also
  resolves `virtual:site-kit/styles` to the site's `content/settings/site.css`
  (empty without one); the entry imports it after `@frontierjs/css`, so it
  reaches every prerendered page as a main-build stylesheet.
- `index.html`, `src/main.js` — the dev shell and the dev entry. The entry is
  `/@site-kit/main.js`: a package name in a script `src` 404s in dev, and an
  inline module script needs an `index.html` on disk.
- `src/blocks/` — content blocks, one `.mesa` each, exported as
  `@frontierjs/site-kit/blocks/<Name>.mesa`.
  - `Marquee.mesa` — a row sliding sideways forever, CSS only so a static page
    needs no script. The slot renders twice; the second copy is `aria-hidden`.
- `test/blocks.mjs` — every block compiles to parseable JS, plus each block's
  render assertions.
- `test/preset.mjs` — a named preset is loaded, or `siteKit()` refuses by name.

## Proving a change

`bun run test` here for the blocks, then `website/`'s own `bun run test` — the build and the verify drive over the site
that consumes it. A change to the preset seam is proved by ksite as well:
`bun run build` in `fjs-prototypes/ksite`, graded with
`baseline/playwright.port.config.ts`. A linked workspace never puts a file
under `node_modules/`, so a defect that only a published engine has
(`FJS-1552`) shows only from a tarball install of both packages.
