# @frontierjs/map-kit

A map FrontierJS draws itself, with no map library and no script on the page.
Private until its first release; the plan is `IDEAS/map-kit.md`.

Stage 1 is a static map: tiles, markers and shapes as SVG that Mesa renders on
the server. `@frontierjs/map-kit/projection` is its pure half:

```js
import { view, fit, tileUrl } from '@frontierjs/map-kit/projection'

const { center, zoom } = fit([{ lat: 40.7, lng: -74 }], { width: 640, height: 360, maxZoom: 19 })
const v = view({ center, zoom, width: 640, height: 360 })
v.tiles.map((t) => tileUrl(basemap, t.x, t.y, t.z)) // what to fetch
v.toLayer({ lat: 40.7, lng: -74 })                  // where a marker goes
```

`@frontierjs/map-kit/StaticMap.mesa` draws the whole map as one SVG, so a server
render holds it and nothing is placed by a `style` attribute:

```html
<script>
  import StaticMap from '@frontierjs/map-kit/StaticMap.mesa'
</script>

<StaticMap
  basemap={{ tiles: 'https://tiles.example/{z}/{x}/{y}{r}.png', attribution: 'Example imagery', maxZoom: 19 }}
  width={640} height={360}
  fit={[outline]}
  shapes={[{ geojson: outline, tone: 'success', treatment: 'outlined' }]}
  markers={[{ at: { lat, lng }, tone: 'info', label: '14 Elm St' }]}
  label="The property at 14 Elm St" />
```

- `label` and `basemap` are required. Give exactly one of `fit` (geometries or
  points to frame; `padding` 20, `maxZoom` the basemap's, capped at 19) and
  `center` (`{ lat, lng }`, with an optional whole `zoom`, default 19).
- A `tone` is one of `@frontierjs/css`'s seven; a shape's `treatment` is
  `outlined` or none. Anything else is refused by name.
- `r` is the `{r}` value, `@2x` when the template has `{r}`.
- The attribution renders as text; an empty one draws no `<figcaption>`.

A basemap is one of two plain-data kinds, never both. A **tiled** one names a
`tiles` template (above). An **image** one names one URL for the whole map, for
a vendor whose API answers a center, a zoom and a size with a single picture
(Google's Maps Static API):

```js
const basemap = {
  image: 'https://api.example/static?center={lat},{lng}&zoom={zoom}&size={width}x{height}&scale={scale}',
  maxSize: 640, // most logical pixels on a side; scale 2 doubles the file, not the area
  maxZoom: 20,
  scale: 2,     // the {scale} value, 1 if absent; `attribution` is usually absent
}
```

- The image covers the whole `width` by `height` box, centered on `center` (or
  the fit's center) at `zoom`, Web Mercator with a 256-pixel world at zoom 0. A
  marker or shape is projected as for tiles, so a center marker sits at the box
  center exactly.
- `width`, `height` and `zoom` must be whole numbers. A box over `maxSize` or
  an explicit `zoom` over `maxZoom` is refused by name, not clamped; a default
  zoom is capped at `maxZoom` and 19 as for tiles.
- The vendor prints its logo and copyright into the picture, so `attribution`
  is normally empty and no `<figcaption>` is drawn.

`bun run test` runs it.
