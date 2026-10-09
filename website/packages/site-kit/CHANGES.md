# Changes — @frontierjs/site-kit

## 2026-10-09 — `layout: Block` is site-kit's (`FJS-D654`, `FJS-D823`)

`src/layouts/Block.mesa` moved here from `@kobami/ksite`, under its own name. A top-level block is css's Band, `<section class="band">` holding a `.container`; a nested one is an `<article>`; one with a `url` is an `<a>`; a stated `tag` is that element, or none with `tag={false}`. Its look is six typed keys: `template` (a Layout helper), `tone`, `treatment`, `density`, `align` and `background`. The allowed values are read from `@frontierjs/css/vocabulary.json`, so a value css does not ship stops the build naming the key and its choices. `classes:` stops it as well, naming the block's class as the place for a look the keys cannot state.

`markdownLayouts` is now site-kit's: its own `src/layouts`, then the preset's, then the site's `content/layouts` when it exists. The package exports `./layouts/*.mesa`.

ksite moved onto it with no visible change. Its four routes are identical to the pixel against the build before the change, at 390, 768, 960, 1024, 1280 and 1536 px, in build and dev, from the workspace and from a tarball install. The one exception is one heading's antialiasing on `/services/` at 960 and 1024 px (0.045%), where the Band starts at x = −4.5px. That exact diff is the grade, not ksite's Playwright baselines, which pass with a stripe's fill removed (Playwright's default color threshold cannot see `#F0F4F8` against white). `test/blocks.mjs` covers each position and each refusal.

## 2026-10-08 — analytics is `analytics:` in `content/settings/site.js` (`FJS-D608`, `FJS-D658`)

The site-kit side needs no new code. The site's settings are spread over the Sierra config, and Sierra's static build now writes the vendor's tag into every page (`FJS-2058`). The README names the key. A probe copy of the website with `analytics: { provider: 'plausible', domain }` tagged 51/51 pages.

## 2026-10-08 — a site names its preset (`FJS-D605`, `FJS-D648`)

`preset: '@kobami/ksite'` in the default export of `content/settings/site.js` names a package that adds to the site. Its `./preset` export is a function of `{ root, content, settings }`, where `settings` is the whole module, named exports included. It returns `sierra` (merged over site-kit's config and under the site's own keys), `plugins` (Vite plugins after Sierra's), and `shell` (`{ html, entry }`, the dev document and the file `/@site-kit/main.js` resolves to). `config/preset.js` loads it, and every way of failing to load one stops the build by name: a package that does not resolve from the site, one with no `./preset` export, a default that is not a function, a returned key outside those three, or a shell missing a half. A site that built without its preset would ship every page without its blocks.

A preset can move neither the routes folder (`content/routes`, `FJS-D606`) nor `_configPath`, which stays the site's settings file, so the browser always reads the site's `theme`. `siteShell()` now takes `{ html, entry }`.

`bin/site-kit.js` runs the site's vite, its peer, through `Bun.resolveSync('vite', root)` (`FJS-2026`). A bare import from a linked site-kit found the frontierjs workspace's copy, and Vite looks for a preset's `sass` beside its own copy.

ksite is the first preset. It builds through `site-kit build site`, 4/4 pixel-exact from the workspace and from a tarball install, in dev and in the build. `test/preset.mjs` covers the loader. The website's `bun run test` is identical to its run before the change.

## 2026-10-04 — `--host` opens a server to the LAN

`site-kit dev` and `site-kit preview` both take `--host`, which makes them listen on every interface. Without it, both answer on localhost only. Before this, `dev` was localhost-only with no way to change it, while `preview` was always on `0.0.0.0` through Sierra's `serveSite` default. `--host` takes no value, so `site-kit dev --host site` still reads `site` as the directory.

## 2026-10-04 — a site without settings runs in dev (`FJS-1709`)

A site with no `content/settings/site.js` hung in dev. With no settings file, site-kit named no `_configPath`, so Sierra pointed `virtual:sierra` at `config/sierra.config.js`, which a content-only site never has. Sierra's hard failure there is deliberate for an app, so the fix is here: site-kit names its own `config/no-settings.js`, an empty default export. The `verify:ask` drive no longer writes a settings file to get past this.

## 2026-10-04 — the route table leaves node_modules

The generated route table is now `<site>/.sierra/routes.js`, gitignored, and
no longer under `node_modules/.sierra/`. Vite treats a file under `node_modules`
as a dependency: it does not watch it, and it serves it as `?v=<hash>` with
`Cache-Control: immutable`. So when a route was added while the dev server ran,
the table on disk had it but the browser kept the old one, even across reloads.
The URL fell through to `[pkg]`, and saving the new file updated nothing. This
was found with a browser drive. A route added mid-session now renders, and an
edit to it swaps in place.

## 2026-10-01 — a site's own stylesheet

`content/settings/site.css` is loaded after `@frontierjs/css` when it exists:
the entry imports `virtual:site-kit/styles`, which `config/shell.js` resolves to
that file or to nothing. Through the entry it is a main-build stylesheet, so the
prerender links it into every page.

## 2026-10-01 — a site is its content/ folder

`site-kit dev|build|preview <dir>` runs a site whose directory holds only
`content/`. The shell (`index.html`), the dev entry (`src/main.js`) and the
Vite + Sierra config (`config/vite.js`) moved here out of `website/site/`;
`config/shell.js` serves the shell to a root that has no `index.html`. The
site's own keys are `content/settings/site.js`, and the generated route table
moved under `node_modules/.sierra/`. The website's build and verify drive are
unchanged by the move, check for check.

## 2026-10-01 — Marquee, the first block

`src/blocks/Marquee.mesa`, exported as `./blocks/*`. CSS only: hover and focus
pause it, `prefers-reduced-motion` stops it and leaves the row scrollable by
hand, and the edge fade is a mask so it fades into any theme's surface. Written
fresh rather than ported from ksite, where no marquee existed; the reference was
a client site's Svelte block, minus its vertical directions and its JS pause.
The website's splash is the first consumer. `test/blocks.mjs` landed with it and
the package's CI exemption went in the same change.

## 2026-09-30 — the package exists, private and empty

A workspace member through the root `website/packages/*` glob, the engine
frontierjs.com and then ksite build on. No exports yet.
