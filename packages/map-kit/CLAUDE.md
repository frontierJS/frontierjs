# map-kit — package map

**`@frontierjs/map-kit`** — a map FrontierJS draws itself. The plan is
`IDEAS/map-kit.md`; read its phase before changing anything.

## Layout

- `src/projection.js` — `project`, `unproject`, `view`, `fit`, `tileUrl`. Pure:
  no DOM, no `window`, no I/O, so the server and the browser give one answer.
  Layer pixels are world pixels minus `view().origin`, and the tile range is
  derived from that same origin, so tiles and markers cannot disagree.
- `src/draw.js` — `imageFrame` (the one-image basemap's URL and placement), `pathData` (GeoJSON to a path `d`), `resolveView` (fit or
  center, exactly one) and `mapModel`, which validates the props and returns
  every number the component prints. Pure, so `bun test` covers every refusal.
- `src/StaticMap.mesa` — markup and styles only; it calls `mapModel` once.
- `test/` — `projection.test.js`: every reference number is from Leaflet 1.9.4's
  formulas (plan 0.3). `draw.test.js` under bun. `static-map.mjs` under node:
  compiles the `.mesa`, parses the output (Invariant 15), renders fixtures and
  compares with `view()` and `tileUrl()` called in the test. `drive.mjs`, the
  browser drive below, and `fixtures/route-site/`, one Sierra route that
  renders a map, and `fixtures/widget-site/`, one Sierra widget (`LotMap`) that
  mounts a map in a shadow root; the drive builds both `dist/`s, ignored.
- `demo/serve.js` — the demo page: three server-rendered maps, fixture tiles
  that print their own z/x/y over a fill `tileColor` names, and
  `@frontierjs/css` from source. `/csp` is the same page under the strict
  policy. `node demo/serve.js` serves it by hand; `PORT` picks the port.

## Traps

- **No `style=` attribute anywhere, script included.** Under `style-src 'self'`
  Chromium applies a `style=` on markup cloned from a template and Firefox does
  not (plan 0.1, `FJS-3549`). Position with SVG attributes and tone classes.
- **A tone is read from `@frontierjs/css/vocabulary.json`**, never copied; a
  rule reading `--bg-mix` must sit on the element with the tone class, so
  `.marker` derives `--marker-ink` for its pin (`tones.css` header).
- Mesa puts its scope class FIRST in a class list (`m1jok… shape success`), so a
  test reads classes through `classOf`, not a regex on `class="shape`.
- Scoped CSS reaches the `.shape` and `.marker` SVG children because the
  component owns them; `.visually-hidden` is css's global class, only applied.
- **The component's CSS must arrive as a sheet, not a `<style>`**, which
  `style-src 'self'` refuses and leaves the map black. The demo links
  `renderComponent`'s `css` (`styleTag: false`).
- **A widget's shadow root sees none of the host's CSS**, so `LotMap.mesa`
  imports `tokens.css`, `tones.css` and `a11y.css` by relative path; Sierra
  adopts them as a constructed sheet (`sierra/src/widget/index.js:148`) and Mesa
  adopts the component's (`mesa/src/runtime.js:1418`), so the strict policy
  never gates them. The tile origin arrives as `data-tiles` and `img-src` names it.
- A drive measures a marker by its center and samples a screenshot to prove a
  tile painted: Firefox counts stroke in a box and Chromium fires no `load` for
  a parsed `<image>` (plan 0.1).
- The attribution is text in Stage 1: an entity or a link in it is not rendered.
- An image basemap's markers are projected from the exact box corner, not the
  tiled view's rounded one, so a center marker is at width/2 height/2; compare
  them within half a pixel, never to the pixel.
- `fit` floors the zoom; Leaflet rounds up within 1%, which overflows the box.
- `project` does not wrap longitude; only a tile's column wraps, and a row
  outside the world is skipped.

## Proving a change

`bun run test` here proves a projection or render change, browserless;
`bun run typecheck` holds baseline 0. `bun run drive` proves the map in a
browser: geometry, painted tiles and styling in Chromium and Firefox, with and
without the strict policy, plus the prerendered route with scripting off and the widget on a host page
under `default-src 'none'` with three origins (tiles, widget, host).
Screenshots land in `.cache/drive/`. It runs under bun: under node, the
happy-dom that `renderComponent` loads breaks the WebSocket `openChrome` uses.
