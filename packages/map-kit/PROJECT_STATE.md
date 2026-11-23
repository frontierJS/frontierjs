# map-kit — Project State

> `CLAUDE.md` is the map. Plan: `IDEAS/map-kit.md`.

`@frontierjs/map-kit` 0.0.0, private.

| | |
|---|---|
| Built | Phase 1: `src/projection.js`. Phase 2 steps 2.1–2.5: `src/draw.js`, `src/StaticMap.mesa`, `test/draw.test.js`, `test/static-map.mjs` |
| Built, Phase 3 | `demo/serve.js`, `test/drive.mjs`, `test/fixtures/route-site/`: the demo page passes in Chromium and Firefox, with and without `style-src 'self'`; the prerendered route holds the map in its HTML |
| Built, widget | `test/fixtures/widget-site/` and the drive's widget section: the map mounted by a Sierra widget in a shadow root passes in Chromium and Firefox under `default-src 'none'; style-src 'self'; img-src <tiles>; script-src <widget>`. Needs `bun install` once for the `@frontierjs/sierra` devDependency |
| Owed | 2.6's second half: measure 256-pixel tiles on a retina screen. A Sierra prerendered route is unstyled under `style-src 'self'`: Sierra writes component CSS as inline `<style>` (`drive` prints it as a `!` finding) |
| Next | Phase 4, once the route finding is ruled |
