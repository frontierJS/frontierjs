---
id: map-kit
status: proposed
dated: 2026-11-22
---

# Idea — map-kit: a map FrontierJS draws itself

**Status: PROPOSED. Stage 1, the static map, is built through Phase 3 in
`packages/map-kit` (2026-11-23, uncommitted); Phase 4 waits on Q3, Q8 and Q9.** Both client apps were read and prior art was surveyed on 2026-11-22
(§ Research). Do not cite this file as behavior; see `VERIFYING.md`.

## The ask, in three turns

All three are the owner's, on 2026-11-22.

1. **From the ELA port:** *"make a unified map Rig"* for ELA and JRLO.
   ELA's port stopped at two steps that need a map and has none.
2. **The layers:** find the right level of dependency for what we do not
   want to maintain, put a FrontierJS layer over it that every app gets, and
   let each app extend that.
3. **The package:** *"this is more than a rig… it could be a map-kit package
   in fjs… leave it private for now while we work it out"*, then *"write up a
   plan for static map / Stage 1"*.

## Where this stands

| Stage | What | State |
| --- | --- | --- |
| 1 | **The static map.** One SVG, rendered on the server, no script, no map library. | Phases 0–3 built; Phase 4 waits on Q3, Q8, Q9 |
| 2 | **Interaction.** Pan and zoom, with the gestures and zoom animation ported from Leaflet 2.0's pointer-event handlers. | after Stage 1 exists (Q2) |
| 3 | **Measuring.** terra-draw through an adapter over our renderer, area from `toolbelt/geo`. | after Stage 2 |
| — | **Vendors.** Tiles, imagery and geocoding, behind a conduit target. | Q3, Q4, Q8 |

The package is `@frontierjs/map-kit`, marked `private: true` while it is worked
out (Q1).

## Why draw it ourselves

A map library is about ten parts (Leaflet's are listed in § Research).

- **Owned, because they touch what FrontierJS already owns:**
  - the projection and coordinate spaces: pure functions shared by the server
    and the browser;
  - the pane, tile grid, markers and vector shapes: Mesa markup, which Sierra
    prerenders, styled with `@frontierjs/css` tones, and bound to live records
    the way a list is;
  - events, which follow Invariant 11;
  - controls, which can be accessible where Leaflet's are weak.
- **Ported from Leaflet's behavior, BSD-2:** the gestures and the zoom
  animation, which are browser physics rather than ideas.
- **Borrowed:** drawing (terra-draw).
- **Never built:** vector tiles.

**What only an owned map can do is render on the server.** The embed, a
property thumbnail and a read-only tracker become maps with no script and no
layout shift. That is also why Stage 1 comes first: it is cheap, it stands on
its own, and it stays useful beside any library a later stage might choose.

## The static map's design

- **One SVG.** A `<figure>` holds an `<svg>` whose `viewBox` is the window in
  layer pixels, with the attribution as its `<figcaption>`:
  - tiles are `<image x y width height href>`;
  - shapes are `<path d>`;
  - markers are `<g transform>`.

  Nothing is placed by a `style` attribute.
- **Why SVG rather than positioned HTML.** Sierra's widgets are built to run
  on host pages with `style-src 'self'` (`packages/sierra/src/widget/index.js:137`).
  That policy blocks a `style=""` attribute. It does not block an SVG geometry
  attribute; this is assumed, and 0.1 proves it.
- **The window is declared, not measured.** The map takes `width` and `height`
  in logical pixels and a zoom. A server render answers every browser global as
  a wide desktop (`ui-hazards` § Routes, prerender and static), so a map that
  measured its box could not render on the server. The SVG scales to its box in
  CSS, and `preserveAspectRatio` chooses between cropping and letterboxing.
- **Numbers stay small.** Layer pixels are world pixels minus the window's
  top-left corner. At zoom 20 the world is 268 million pixels wide.
- **Shapes of the data.**
  - A point is `{ lat, lng }`, `toolbelt/geo`'s shape.
  - A shape is GeoJSON, `[lng, lat]`.
  - An app maps its own columns; ELA's are `latitude` and `longitude`.
- **Tones, not colors.** A marker or shape takes a tone and a treatment, never
  a color (Invariant 13).
- **Projection lives in map-kit, as `@frontierjs/map-kit/projection`.** Tile
  pixels are display math with one consumer. `toolbelt/geo` keeps distance and
  area, and map-kit imports them. Move it to toolbelt only if a server-side user
  appears.
- **Data props in Stage 1, not child layer components.** `markers` and `shapes`
  are plain arrays. A child layer needs shared map state, which arrives with
  interaction in Stage 2.
- **The basemap is data:** `{ tiles, attribution, maxZoom, tileSize, subdomains }`,
  where `tiles` is a URL template with `{z}`, `{x}`, `{y}`, `{s}` and `{r}`.

**A sketch of the call site, not a contract:**

```html
<StaticMap
  basemap={imagery}
  width={640} height={360}
  fit={[outline]}
  shapes={[{ geojson: outline, tone: 'success', treatment: 'outlined' }]}
  markers={[{ at: { lat, lng }, tone: 'info', label: '14 Elm St' }]}
  label="The property at 14 Elm St" />
```

## Plan — Stage 1, the static map

### Phase 0 — Probes and reading

Goal: the two assumptions the design rests on are proved, and the projection's
test cases are written down from Leaflet's source.
Done when: 0.1–0.4's results are recorded under their steps.

- [x] 0.1 **SVG under `style-src 'self'`.** Serve a page with that policy
  holding `<svg viewBox>`, `<image x y href>` and `<g transform>`, and check
  the image lands at its `x` and `y`. Check in Firefox, the browser the CSP
  drives use (`FJS-3549`, see `packages/sierra/test/fixtures/widget-site/test/verify.mjs`),
  and in Chromium. If it fails, the design changes before anything is built.

  **Result, 2026-11-22: the design holds in both engines.** The probe was a
  scratch page served with `default-src 'none'; style-src 'self'; img-src 'self'; script-src 'self'`.
  It held the same SVG twice: once parsed from the HTML, and once cloned from a
  `<template>` into a shadow root by a script, the way a widget renders. It ran
  in Chrome stable and in playwright-core's Firefox.
  - The `viewBox`, `<image x y width height href>`, `<path d>` and
    `<g transform>` each landed at the predicted pixel, in both panes. A CSS
    box from a `'self'` stylesheet scaled them by 0.5, and the tile painted.
  - Tone classes from a `'self'` stylesheet applied.
  - Every `style=""` was blocked, with one exception: Chromium applies a
    `style=""` on markup cloned from a template, and Firefox does not (the trap
    behind `FJS-3549`). So the map uses no `style=` anywhere, script included.
  - A Phase 3 drive must not rely on two things:
    - Firefox counts a path's stroke in `getBoundingClientRect` and Chromium
      does not, so measure a marker by its center.
    - Chromium fired no `load` event for the parsed `<image>` although it
      painted, so wait on the screenshot, not on `load`.
- [x] 0.2 **Mesa renders SVG on the server.** An SVG with a computed `viewBox`
  and `<image href>`, through `compileSource` and `renderComponent` as
  `packages/site-kit/test/blocks.mjs` does. Check that the output parses
  (Invariant 15), that `href` survives, and that the client mount keeps the SVG
  namespace.

  **Result, 2026-11-22: holds.** The probe component, in a scratch directory,
  has an `{#each}` of `<image>`, a `<path>`, and an `{#each}` of markers as
  `<g transform>` with a `<title>`.
  - `compileSource` reported no errors, and acorn parses its output.
  - `renderComponent` printed the props' `viewBox="1000 2000 640 360"`, one
    `<image … href>` per row, the `<path d>` and
    `<g transform="translate(1320 2180)">` with its `<title>`.
  - Mounted with `mount()` under 0.1's policy, in Chromium and in Firefox, all
    seven SVG elements carry the SVG namespace. The tiles, shape and marker
    land where 0.1's did.
  - The server output has no `xmlns` on `<svg>`. HTML does not need one; a
    standalone `.svg` export would.
- [x] 0.3 **Read the sources and write the test cases.** Leaflet's
  `CRS.EPSG3857`, `SphericalMercator`, `Transformation` and `GridLayer`'s tile
  range (BSD-2), and pigeon-maps. The edge cases become test cases:
  - latitude clamped at ±85.0511°;
  - `x` wrapping across the antimeridian;
  - a `y` outside 0…2^z−1 skipped;
  - the zoom limits.

  **Result, 2026-11-22.** The sources were Leaflet 1.9.4 (`src/`) and
  pigeon-maps 0.22.1. The numbers were computed in node from Leaflet's formulas,
  reimplemented rather than loaded. Over 200,000 random points, the OSM
  slippy-map formula agrees with `floor(project / 256)`. File references are to
  Leaflet's `src/`.

  **Constants.**
  - The projection uses R = 6378137 (`Projection.SphericalMercator.js:18`).
    `CRS.Earth.R` = 6371000 is for distance only, so the two never mix.
  - `MAX_LATITUDE` is 85.0511287798.
  - A world is 256·2^z pixels wide.

  **`project`, in world pixels.**

  | lat, lng, z | x | y | tile |
  | --- | --- | --- | --- |
  | 0, 0, 0 | 128 | 128 | 0, 0 |
  | 0, 180, 0 | 256 | 128 | 1, 0 (the east edge) |
  | 89, 10, 0 | 135.111111 | 0 (clamped) | 0, 0 |
  | 40.7128, −74.006, 10 | 77182.475378 | 98561.110379 | 301, 385 |
  | 40.7128, −74.006, 17 | 9879356.848356 | 12615822.128454 | 38591, 49280 |
  | 40.7128, −74.006, 20 | 79034854.786844 | 100926577.027633 | 308729, 394244 |
  | −33.8688, 151.2093, 17 | 30870944.262827 | 20135754.645300 | 120589, 78655 |

  **Tile ranges.** The pixel center is floored, the bounds are center ± size/2,
  and the range is `[floor(min/256), ceil(max/256) − 1]` (`GridLayer.js:634-641`,
  `:904-909`).

  | center, z, size | raw range | tiles |
  | --- | --- | --- |
  | 40.7128, −74.006, 17, 640×360 | x 38589…38592, y 49279…49281 | 12 |
  | 0, 179.5, 3, 512×256 | x 6…8, y 3…4 | x 6, 7, **0** |
  | 0, −179.5, 3, 512×256 | x −1…1, y 3…4 | x **7**, 0, 1 |
  | 0, 0, 0, 1024×768 | x −2…2, y −1…1 | y ±1 skipped; five copies of (0, 0) |
  | 80, 0, 2, 512×512 | x 1…2, y −1…1 | y −1 skipped; 4 tiles |
  | 0, 0, 1, 256×256 | x 0…1, y 0…1 | 4 tiles: a max exactly on an edge adds none |

  **`fit`.**
  - The padding is subtracted from the size, and the scale is the smaller of
    the two axes' (`Map.js:865-890`).
  - The center is the midpoint in projected pixels, not in degrees.

  | bounds, size, padding, maxZoom | zoom | center |
  | --- | --- | --- |
  | a 100 m × 60 m lot at 40.7, −74; 640×360; 20; 20 | 19 (raw 19.27) | 40.7, −74 to 1e-8 |
  | the same lot, maxZoom 18 | 18 | the same |
  | 40.4774, −74.2591 to 40.9176, −73.7004; 800×600; 20; 20 | 10 (raw 10.41) | 40.697864, −73.97975 |
  | a single point; maxZoom 20 | 20 | the point |

  **Rules that become tests.**
  - Latitude clamps inside `project` (`SphericalMercator.js:24`), but the
    clamped y is not exactly 0: it is 5.45e-11 at z0 and 5.7e-5 at z20. Test
    with a tolerance.
  - The raw OSM formula does not clamp: lat 89 at z0 gives tile y −1. So
    `tileUrl` takes tiles from `view()`, never from that formula.
  - `project` does not wrap longitude: lng 181 gives x 256.711 at z0. Only the
    tile x wraps, as `((x % n) + n) % n` (`Util.js:100-105`).
  - y is never wrapped. A y outside `0…2^z−1` is skipped (`GridLayer.js:720-730`).
  - A round trip stays within 1e-9° and 1e-6 px. `unproject` can return
    −74.00000000000001, so a test compares with a tolerance.
  - `{s}` is `subdomains[abs(x + y) % n]` (`TileLayer.js:233-236`). `{x}` and
    `{y}` are the wrapped values. A template key with no value throws.
  - `{r}` is an explicit argument, because a server render cannot know the
    screen's density. TMS, `zoomOffset` and `zoomReverse` are not needed in
    Stage 1.

  **Choices for 1.3 and 1.4.** These are recommendations, settled when those
  steps are built:
  - **The window's origin:** `round(project(center) − size/2)`, Leaflet's
    `_getNewPixelOrigin` (`Map.js:1503-1506`). The tile range is derived from
    that same origin rather than from a floored center, so tiles and
    `toLayer` cannot disagree. The two differ by at most 1 px.
  - **Copies of a wrapped tile are kept**, each at its own position, as
    Leaflet does.
  - **`fit` floors the zoom.** Leaflet first rounds a zoom within 1% of the
    next whole level up (`Map.js:883`), so a fitted shape can overflow by
    about 0.7%. A static box has no pan to recover that.
  - **A fit across the antimeridian is out of scope.** Leaflet's bounds assume
    west < east too.
- [x] 0.4 **Measure the reference.** The size and zoom of ELA's
  `embeds/src/Shared/MapView-Elite.svelte` static map and of
  `PropertyMapView.svelte`, so the defaults match screens that exist.

  **Result, 2026-11-22.** Paths are in `~/code/CLIENTS/elitelawncare/ela`.
  - **The embed** (`embeds/src/Shared/MapView-Elite.svelte:29-32`) uses Google
    Static Maps:
    - `size=500x300`, `zoom=19` fixed, `maptype=satellite`, and no `scale`;
    - no marker and no shape.

    It prefers a Street View photo and falls back to this aerial. It shows
    only on the contact step, when `showMap` is set (`StepContact.svelte:72-74`).
    It is sized by `.address-image`: `w-full max-w-500px object-cover`
    (`embeds/src/Embeds/LawnEstimator/app.scss:327-330`).
  - **The property view** (`web/src/components/PropertyMapView.svelte:77-97`
    and `:167-188`) uses Google's JS map:
    - roadmap at a fixed zoom 12, with one red pin;
    - a 160 px-high pane above a Street View pane.
  - **Neither draws a lot outline.** Shapes first appear with the tracker and
    with the measure map in Stage 3.
  - **The defaults this gives:**
    - 500×300;
    - zoom 19 for a lone point;
    - `fit` with `maxZoom: 19`.
  - **What this does to Q9:** the embed shows only satellite imagery, so Q9's
    option A also needs Q3 and Q8 answered before Phase 4.

### Phase 1 — The pure half

Goal: `@frontierjs/map-kit/projection`, with no DOM and the same answer on the
server and in the browser.
Done when: `cd packages/map-kit && bun run test` passes in node with no DOM
global. That includes round trips, and reference tile numbers from the OSM
slippy-map formula.

- [x] 1.1 Scaffold `packages/map-kit`:
  - `private: true`, plain ESM;
  - `README.md`, `CLAUDE.md` and `PROJECT_STATE.md` (Invariant 17);
  - a `test` script, and a typecheck baseline of 0.
- [x] 1.2 `project(point, zoom)` and `unproject(px, zoom)`: Web Mercator,
  256-pixel tiles.
- [x] 1.3 `view({ center, zoom, width, height })` returns the window's origin,
  the tiles that cover it (with `x` wrapping) and `toLayer(point)`.
- [x] 1.4 `fit(geometries, { width, height, padding, maxZoom })` returns
  `{ center, zoom }`. Whole zooms only in Stage 1.
  - A test asserts that the fitted bounds never overflow the padded box, for
    raw zooms 19.27 and 10.41 and for a zoom 0.5% below a whole level, where
    Leaflet would round up.
  - Bounds whose west lies east of their east, which is a fit across the
    antimeridian, are refused by name rather than fitted to the whole world.
- [x] 1.5 `tileUrl(basemap, x, y, z)` fills in the template.

### Phase 2 — `StaticMap.mesa`

Goal: one component that renders a complete map on the server.
Done when: a kit test renders fixture maps on the server, parses the output,
and checks tile `href`s and positions, a shape's `d` and a marker's
`transform` against what `projection` predicts.

- [x] 2.1 **The frame.**
  - `<figure>`, and an `<svg viewBox>` from `view()`.
  - The tiles as `<image>`.
  - The attribution as `<figcaption>`.
  - A background, so a missing tile shows as missing rather than as a hole.
- [x] 2.2 **Shapes.** GeoJSON `Polygon`, `MultiPolygon` and `LineString` become
  `<path d>` in layer pixels, with tone and treatment classes from
  `@frontierjs/css`.
- [x] 2.3 **Markers.** A glyph in `<g transform>`, a tone, and the label as
  `<title>`.
- [x] 2.4 **Placing the window.** `fit`, or `center` plus `zoom`. One of the
  two is required, and both together is refused.
- [x] 2.5 **Accessibility.** `role="img"` and `aria-label` on the SVG. The
  marker labels are also a visually hidden list, so a screen reader hears what
  the map shows.
- [ ] 2.6 **Sharp on a retina screen.** Use the basemap's `{r}` where it has
  one. Otherwise measure 256-pixel tiles on a retina screen before trying
  anything cleverer.

  **Built, 2026-11-23, with one default for the owner to confirm.** A server
  render cannot know the screen's density and an SVG `<image>` has no `srcset`,
  so when the template has `{r}` the map asks for `@2x` tiles on every screen
  and draws them at 256 layer pixels. That is sharp everywhere and about four
  times the tile bytes on a 1x screen. The `r` prop overrides it; flipping the
  default to `''` is one line in `src/draw.js`. The second half, measuring a
  basemap with no `{r}` on a real retina screen, is still owed.

### Phase 3 — In a browser and a Sierra route

Goal: the map is in the HTML before any script runs, and it looks right under
the strict policy.
Done when: a drive passes in Chromium, and in Firefox under `style-src 'self'`.
`curl` of a prerendered route shows the `<svg>` with its tiles.

- [x] 3.1 **A demo page in the kit, with fixture tiles.** Each tile is an SVG
  that prints its own z/x/y, so a wrong tile is visible in a screenshot. A
  drive finds a marker at the pixel `projection` predicts.
- [x] 3.2 **The same page under `style-src 'self'` in Firefox**, after the
  widget-site fixture's CSP page.
- [x] 3.3 **A Sierra prerendered route** renders a `StaticMap`, and its HTML
  carries the map with scripting off.

**Result, 2026-11-23: the phase's done-when is met, with one defect found
outside the kit.** `cd packages/map-kit && bun run drive` runs all three steps
and leaves screenshots in `.cache/drive/`.
- **The demo page** (`demo/serve.js`) passes in Chromium and Firefox, with and
  without `default-src 'none'; style-src 'self'; img-src 'self'; script-src 'self'`:
  every tile at its predicted box, each tile painted the tile it names (sampled
  from the screenshot), each marker's center on its point, the shapes' boxes,
  and the tones applied. The page links the component's CSS as a `'self'`
  stylesheet.
- **The prerendered route** holds the whole map in its HTML and places it
  correctly with scripting off. Under the strict policy it is **unstyled**:
  Sierra's prerender writes component CSS as an inline `<style>`, which the
  policy refuses, so an outlined shape paints solid black (`FJS-4585`). The
  drive prints this as three `!` lines and still passes; they become hard
  checks when `FJS-4585` closes.
- **A Sierra widget** (`test/fixtures/widget-site`, added beyond the three
  steps because Q9's option A is a widget) mounts the map in a shadow root on
  a host page under `default-src 'none'; style-src 'self'`, with tiles, widget
  and host on three origins. It passes in both engines, placed and styled: the
  widget adopts its CSS as constructed sheets, which the policy does not gate.
  The tile origin reaches the widget as `data-tiles`, and the host's `img-src`
  must name it.

### Phase 4 — The first consumer

Goal: a real ELA screen shows a map from map-kit.
Done when: the ELA port's drive for that screen passes with the map in it.

- [x] 4.1 The owner picks the screen (Q9) and the tile source (Q8).
  **Ruled 2026-11-23:** the estimator widget (`FJS-D2337`), through a tile
  proxy route in the app's API (`FJS-D2336`), drawing Esri World Imagery with
  NAIP where there is no key (`FJS-D2335`).
- [ ] 4.2 Wire it in; the app maps `latitude` and `longitude` to `{ lat, lng }`.
  The owner ruled the parts on 2026-11-23, and a survey of the port found the
  estimator has no map, no coordinates and no drive today:
  - [x] 4.2a **Conduit returns bytes.** It already did: a response whose
    `content-type` is not JSON, text or markup comes back as a `Uint8Array`
    (`FJS-D585`), and `FJS-D934` refused a request option for it. So no mode
    was added. Closed 2026-11-23: a binary body on a non-2xx is named in `raw`,
    not decoded into it; a stub mock can carry `headers`; and the README shows
    a tile through `send()` as a run example.
  - [ ] 4.2b **An Esri imagery connector and a keyless NAIP target** on 4.2a,
    shaped like `conduit-plausible`.
  - [ ] 4.2c **The tile route in ELA's API.** Public, so it finds its account
    by the form's public key, parses z/x/y as range-checked integers against a
    fixed upstream, sets `cache-control`, and is rate limited. The Esri key is
    an `Integration` row's `@encrypted` secret; with no row it serves NAIP.
  - [ ] 4.2d **The estimator's address autocompletes.** The owner overruled
    ELA ruling 51 for the widget; the port's precedent is Radar (ELA D91), and
    its result carries the coordinates the map needs.
  - [ ] 4.2e **The map in the estimator's review step**, with map-kit linked
    from this tree (`link:`) until it publishes, before cutover. ELA's pinned
    mesa and sierra may be too old to compile `StaticMap.mesa`; raise them if so.
  - [ ] 4.2f **A widget drive in ELA**, on a host page under the strict policy
    whose `img-src` names the API origin. Phase 4's done-when needs it.
- [ ] 4.3 Grade it against the reference screen it replaces.

Stages 2 and 3 are planned after Phase 4, from what Stage 1 taught.

## Open questions

- ~~**Q1 — Where does the map live?**~~ **Answered 2026-11-23 (`FJS-D2330`): B — a kit of its own, `@frontierjs/map-kit`, that draws the map itself and stays `private` while it is worked out.**
  - **A** — a rig: linked parts plus `.mesa` shells copied into the app,
    wrapping a vendor renderer.
  - **B** — a kit of its own, `@frontierjs/map-kit`, that draws the map itself
    and stays `private` while it is worked out.
  - **C** — inside `@frontierjs/ui`, which `FJS-D327` refused.
  - **Recommend A** — written before the static-map design existed: a rig keeps
    the vendor renderer out of the framework.
- **Q2 — The interactive renderer, for Stage 2.**
  - **A** — our own renderer, with Leaflet 2.0's gestures and zoom animation
    ported in.
  - **B** — MapLibre 6 for the interactive screens; Stage 1 stays for the
    static ones.
  - **C** — Leaflet for the interactive screens.
  - **Recommend: rule after Stage 1**, by grading a port of Leaflet's gestures
    on a real phone against Leaflet itself. terra-draw has adapters for every
    option, so the drawing code does not change with the pick.
- ~~**Q3 — Tiles and imagery, and whose key.**~~ **Answered 2026-11-23 (`FJS-D2335`): A — Esri World Imagery as an opt-in vendor keyed per account, about 30 cm, and NAIP as the free fallback where there is no key.**
  - **A** — Esri World Imagery as an opt-in vendor keyed per account, about
    30 cm, and NAIP as the free fallback where there is no key.
  - **B** — NAIP only: public domain and keyless, at 60 cm.
  - **C** — Nearmap for ELA, about 5–7 cm, if ELA's subscription includes API
    access (unverified).
  - **Recommend A** — Esri allows commercial apps and gives 2M tiles a month
    free, and NAIP keeps a keyless app working. Nearmap can be added as another
    basemap descriptor once ELA's API access is verified.
- **Q4 — Geocoding and autocomplete.**
  - **Recommend: a conduit target.** Every surveyed framework keeps a provider
    registry apart from display, and conduit already is that registry. The kit
    ships the address field, and the app's property row holds the location.
- **Q5 — What V1 is.** Stage 1 covers the embed, the property view and a
  read-only tracker. The measure map (ELA 24.9a) waits for Stage 3.
- **Q6 — Is live crew position part of this?**
  - **Recommend: no.** Live position needs a transport and a consent model, not
    a map. The tracker's route and visit pins are `shapes` and `markers` the app
    supplies.
- **Q7 — The public embed.**
  - **Recommend: Stage 1's static map.** It loads no library, which is what a
    static-image endpoint was for.
- ~~**Q8 — How a keyed tile source reaches the page.**~~ **Answered 2026-11-23 (`FJS-D2336`): B — a tile proxy route in the app's API: the key stays on the server, tiles can be cached, and the browser only ever asks the app's own origin.** A static map's tile URLs
  sit in the HTML, so a key in them is public.
  - **A** — a key in the URL, restricted to the app's referrer. Whether Esri
    supports that is unverified.
  - **B** — a tile proxy route in the app's API: the key stays on the server,
    tiles can be cached, and the browser only ever asks the app's own origin.
  - **C** — keyless raster tiles only, such as CARTO (terms unchecked). There is
    no imagery this way.
  - **Recommend B** — it is the only option where no key reaches a browser.
    Same-origin tiles also fit a strict `img-src` (inference). Stage 1 tests use
    fixture tiles and does not wait on this.
- ~~**Q9 — The first consumer.**~~ **Answered 2026-11-23 (`FJS-D2337`): A, accepting a wait.**
  - **A** — the estimator widget's static map, the reference's
    `MapView-Elite.svelte`. This is the strict-CSP case.
  - **B** — the property on the intake screen, for an existing property with a
    location (ELA 14.3).
  - **C** — a read-only tracker: the route as a line, the visits as markers
    (part of ELA 23.9).
  - **Recommend A, accepting a wait.** It exercises the hardest constraint, a
    host page's policy, on the smallest screen. But 0.4 found that A is a
    satellite image at zoom 19, so Phase 4 also waits on Q3 and Q8 for its
    imagery. B is a roadmap at zoom 12, which a keyless roadmap source could
    serve sooner, without the strict policy.

## Research (2026-11-22)

Four read-only passes: the two apps' code, renderers and draw engines, vendors,
and how other frameworks split the work. **[unverified]** marks a claim taken
from a secondary source; *inference* marks reasoning that was not sourced.

### The two apps

Paths are relative to `~/code/CLIENTS/elitelawncare/ela` (ELA) and
`~/code/CLIENTS/justrightlawns/jrlo` (JRLO).

| Capability | ELA | JRLO | State |
| --- | --- | --- | --- |
| measure a property | `CallIntake/Map.svelte` | `LotMap.svelte` (Leaflet + Geoman) | the same events, a different vendor |
| crew tracker map | `Tracker/Map.svelte` (raw Leaflet, CARTO tiles) | the same file | near-identical (7-line diff) |
| address autocomplete | 2 web and 1 embed live copies (Google Places) | 2 web and 1 embed | 6 drifted copies, one shared bug |
| planner and lead map | `components/Map.svelte`, 746 lines | `components/Map.svelte`, 301 lines, **dead** | ELA's grew from JRLO's |
| property view | `PropertyMapView.svelte` (Google + Street View) | none | ELA only |
| public embed | `MapView-Elite.svelte` (a static map image) | `MapView.svelte`, **dead and broken** | ELA only |

**ELA's measure map, by job.**

- **Imagery:** Google's satellite layer.
- **Drawing:** a hand-written click-to-draw tool, `createPolygonDrawer`. It
  replaced Google's `DrawingManager`, which Google removed in Maps JS v3.65.
- **Editing:** Google's `Polygon` with `editable: true`.
- **Area:** `geometry.spherical.computeArea`.
- **Area label:** an `OverlayView`.

**The interface both apps reached independently.** ELA's and JRLO's measure
maps emit the same events (`mounted`, `clear`, `polygonChange`,
`areaCalculated`, `error`) and take the same `actions[]` prop (Save as Lot,
Save as Turf). Stage 3 keeps that interface.

**Why logic is not copied into apps.** Address autocomplete exists in six live
copies, and every web copy appends `,geometry` after `callback=initMap`, so the
geometry library never loads (`ela/web/src/components/AddressAutocomplete.svelte:132-136`).

**Found in the apps, owed to them rather than to this file:**

- Google keys are hard-coded in about 15 places, and one key is shared by both
  clients.
- The planner fetches `http://{s}.google.com/vt/` tiles directly, which is
  outside Google's terms.
- Live ELA stores lat/lng from Google's geocoder, which Google limits to 30
  days.
- Dead files: ELA's `LeadGoogleMap.svelte` and both apps' `Tracker/Google.js`.

### Leaflet's pieces

Leaflet is built from these parts:

1. The projection (`CRS.EPSG3857`).
2. Four coordinate spaces: LatLng, world pixels, layer pixels and container
   pixels.
3. Panes inside one map pane, which a pan moves with a single `translate3d`.
4. The tile grid (`GridLayer`).
5. Zoom animation: the old level is scaled while the new one loads.
6. Interaction handlers: drag with inertia, wheel, pinch, keyboard.
7. Layers with `onAdd` and `onRemove`: markers, popups, and paths that are
   clipped and simplified.
8. Renderers: SVG or Canvas.
9. An `Evented` mixin.
10. Controls and bounds helpers.

[pigeon-maps](https://github.com/mariusandra/pigeon-maps) shows that 1–4 plus
markers make a working raster map on their own.

### Renderers and draw engines

- **Leaflet.** 1.9.4 is still npm `latest`.
  [2.0.0-beta.5 shipped 2026-11-19](https://github.com/Leaflet/Leaflet/releases).
  2.0 is ESM only, built on pointer events, and its plugins break until they are
  ported ([MIGRATION.md](https://github.com/Leaflet/Leaflet/blob/main/MIGRATION.md)).
  It is 42 KB gz.
- **MapLibre GL JS.**
  [6.19.0 shipped 2026-11-17](https://github.com/maplibre/maplibre-gl-js/releases).
  About 300 KB gz, and it requires WebGL.
- **OpenLayers.** [10.11.0](https://github.com/openlayers/openlayers/releases).
  The only option with draw, snap and an area readout built in.
- **terra-draw.** 1.40.0, MIT, 47 KB gz, adapters for six renderers
  ([packages](https://github.com/JamesLMilner/terra-draw/tree/main/packages)).
  It handles snapping, vertex editing and area validation, but has no area
  label. Google's [deprecations page](https://developers.google.com/maps/deprecations)
  names it as the replacement for the Drawing library.
- **leaflet-draw** is effectively unmaintained
  ([repo](https://github.com/Leaflet/Leaflet.draw)).
- **The wrappers are thin.** [react-map-gl](https://github.com/visgl/react-map-gl)
  is one 22 KB prop-sync core plus 1–4 KB per component.

### Vendors

**Whether a geocode may be stored decides the vendor.**

- **Google** limits stored lat/lng to 30 days
  ([policies](https://developers.google.com/maps/documentation/geocoding/policies)).
- **Mapbox** "temporary" geocoding results cannot be stored
  ([docs](https://docs.mapbox.com/help/dive-deeper/understand-temporary-vs-permanent-geocoding/)).
- **Esri** ([ArcGIS Location Platform](https://location.arcgis.com/pricing/)):
  - Commercial apps are allowed
    ([licensing](https://location.arcgis.com/help/licensing-and-attribution/)).
  - Tiles: 2M a month free.
  - Stored geocodes: $4 per 1,000.
  - Imagery: about 30 cm across most of the suburban US.
  - The keyless `services.arcgisonline.com` URL is not licensed for commercial
    use.
  - Its clause on showing stored results on a non-Esri map was not retrieved.
- **Free and legally clean:**
  - [OpenFreeMap](https://openfreemap.org/): vector only.
  - [NAIP](https://www.usgs.gov/centers/eros/science/usgs-eros-archive-aerial-photography-national-agriculture-imagery-program-naip):
    public domain, 60 cm.
  - The [Census geocoder](https://geocoding.geo.census.gov/geocoder/Geocoding_Services_API.html).
- **Not for production:** the [OSM tile](https://operations.osmfoundation.org/policies/tiles/)
  and [Nominatim](https://operations.osmfoundation.org/policies/nominatim/)
  servers.
- **Retiring:** Bing Maps for Enterprise ends 2028-06-30
  ([Microsoft](https://blogs.bing.com/maps/2025/1/What-are-my-options-regarding-Bing-Maps-for-Enterprise-Retirement/)).

### How other frameworks split it

| Who | Library | Framework owns | App owns | Keys |
| --- | --- | --- | --- | --- |
| [GeoDjango](https://github.com/django/django/blob/main/django/contrib/gis/forms/widgets.py) | OpenLayers, from a CDN | widget, (de)serializer, `layerBuilder` | subclass, `base_layer` | none |
| [Directus](https://github.com/directus/directus/blob/main/app/src/utils/geometry/basemap.ts) | MapLibre + Mapbox Draw | geometry type, `BasemapSource` | `basemaps[]` as a settings row | database |
| [Frappe](https://github.com/frappe/frappe/blob/develop/frappe/public/js/frappe/form/controls/geolocation.js) | Leaflet, vendored | field, geocoding provider registry | patching hard-coded tile URLs | settings doctype |
| [Payload](https://github.com/payloadcms/payload/blob/main/docs/fields/point.mdx) | none | point field, index, queries | any map | — |
| [mapcn](https://github.com/AnmolSaini16/mapcn) | MapLibre | nothing (a copy-in registry) | the whole 82 KB `map.tsx` | keyless default |

**What recurs:**

- geocoding is a server-side provider registry, separate from display;
- the basemap is data;
- the default needs no key;
- the raw instance is exposed.

**What went wrong:**

- locking to one vendor (filament-google-maps);
- a wrapper too thick (Directus patches Mapbox Draw's CSS class names);
- leaving it to the community (Strapi: four plugins, four storage formats);
- a CDN that breaks under a strict CSP (GeoDjango).

**Not done.** Primary clause text for Mapbox, Google and Esri on storage and
display; terra-draw's custom-adapter API stability; Nearmap's API terms.
