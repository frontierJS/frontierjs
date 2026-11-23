# map-kit — Project State

> `CLAUDE.md` is the map. Plan: `IDEAS/map-kit.md`.

`@frontierjs/map-kit` 0.0.0, private.

| | |
|---|---|
| Built | Phase 1: `src/projection.js`. Phase 2 steps 2.1–2.5: `src/draw.js`, `src/StaticMap.mesa`, `test/draw.test.js`, `test/static-map.mjs` |
| Built, Phase 3 | `demo/serve.js`, `test/drive.mjs`, `test/fixtures/route-site/`: the demo page passes in Chromium and Firefox, with and without `style-src 'self'`; the prerendered route holds the map in its HTML |
| Built, widget | `test/fixtures/widget-site/` and the drive's widget section: the map mounted by a Sierra widget in a shadow root passes in Chromium and Firefox under `default-src 'none'; style-src 'self'; img-src <tiles>; script-src <widget>`. Needs `bun install` once for the `@frontierjs/sierra` devDependency |
| Built, step 4.4a | The one-image basemap `{ image, maxSize, maxZoom, scale, attribution }`: `imageUrl` in `src/projection.js`, `imageFrame` in `src/draw.js`, one `<image>` in `StaticMap.mesa`; `bun run test` and the demo's `image-500` map in the drive, all four engine/policy runs |
| Owed, step 4.4a | **The Google framing probe.** The pure half assumes Google's Static API frames Web Mercator with a 256-pixel world at zoom 0 and that `scale=2` covers the same area at double pixels; both are from its documentation, unverified, because the probe needs a real key (the owner's). The drive's image is a stand-in that only proves the box, the URL and the marker |
| Owed | 2.6's second half: measure 256-pixel tiles on a retina screen. A Sierra prerendered route is unstyled under `style-src 'self'`: Sierra writes component CSS as inline `<style>` (`drive` prints it as a `!` finding) |
| Next | Phase 4, once the route finding is ruled |
