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
- The attribution renders as text.

`bun run test` runs it.
