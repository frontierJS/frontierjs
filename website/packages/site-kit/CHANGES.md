# Changes — @frontierjs/site-kit

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
