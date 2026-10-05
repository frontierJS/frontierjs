# Changes — @frontierjs/site-kit

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
