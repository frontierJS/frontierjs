# @frontierjs/conduit-esri

One raster tile of aerial imagery over `@frontierjs/conduit`, for an app's public tile-proxy route (`FJS-D2335`, `FJS-D2336`). New, sink-only. Two sources and one verb: **Esri World Imagery**, keyed per account, and **USGS NAIP**, keyless. Choosing between them is the route's policy; a missing account key answers `no_key` so the route can fall back.

## What it covers

| Piece | Where |
| --- | --- |
| targets | `esriImageryTarget({ ref?, address? })` — `api_key`, `query: 'token'`, `per_caller`; `naipTarget({ address? })` — no auth |
| calls | `esriTile(send, { z, x, y }, { who? })`, `naipTile(send, { z, x, y })` — each `replayable: true`, each answers `{ tile?, error? }` |
| tile | `{ bytes: Uint8Array, contentType, cacheControl?, etag? }` — the vendor's bytes, untouched |
| basemap | `basemap('esri' \| 'naip', tilesTemplate)` → `{ tiles, attribution, maxZoom, tileSize }`, plain data in map-kit's shape |
| errors | `translate(error, status)` — table below |
| sink | `sink.ts` — both tile paths, Esri's 200-with-`error` key refusal |
| drive | `bun run test` — 20 rows, sink only, no network |

```ts fragment
import { createConduit } from '@frontierjs/conduit'
import { esriImageryTarget, naipTarget, bindSend, esriTile, naipTile, basemap } from '@frontierjs/conduit-esri'

await conduit.register(esriImageryTarget())   // ref ESRI_API_KEY, asked as getFor(ref, who)
await conduit.register(naipTarget())

const r = await esriTile(bindSend(conduit, 'provider:esri-imagery'), { z, x, y })
const t = r.error?.kind === 'no_key' ? await naipTile(bindSend(conduit, 'provider:naip'), { z, x, y }) : r
if (t.tile) return new Response(t.tile.bytes, { headers: { 'content-type': t.tile.contentType } })
```

## Errors

| case | `TileFailure.kind` | retryable | sent |
| --- | --- | --- | --- |
| z, x, y not integers in range for the source | `refused` | no | nothing |
| no key resolved for this caller | `no_key` | no | nothing |
| 401/403, or Esri's `{ error: { code: 498 \| 499 } }` under a 200 | `bad_key` | no | yes |
| 404 | `no_tile` | no | yes, once |
| 2xx that is not `image/png`, `jpeg` or `webp` | `not_an_image` (a JSON error body: `bad_key` or `refused`) | no | yes |
| 429, 5xx, timeout | conduit's kind, replayed by conduit | as conduit | yes |

`raw` is never forwarded, and the key rides the URL only inside conduit's transport (`FJS-D940`).

## Ranges

| source | max zoom | tile | order |
| --- | --- | --- | --- |
| Esri `World_Imagery` | 19 | 256 px, JPEG | `{z}/{y}/{x}` |
| NAIP `USGSImageryOnly` | 16 | 256 px, JPEG or PNG | `{z}/{y}/{x}` |

Past a source's max zoom the call is `refused` before any send. A consumer asking for zoom 19 over NAIP overzooms level 16 client-side (`maxZoom: 16` in the descriptor); NAIP's cache is about 2.4 m per pixel there.

## Sources

Where a primary page could not be read, the line says what was used instead.

- **Esri tile URL and key:** `https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?token=<API key>` — <https://developers.arcgis.com/openlayers/maps/raster-tile-basemaps/display-multiple-basemap-layers/> and <https://www.esri.com/arcgis-blog/products/developers/developers/open-source-developers-time-to-upgrade-to-the-new-arcgis-basemap-layer-service> (the blog page was 403 to the fetcher; its URL form came back through search). The key needs the Location services > Basemaps privilege.
- **`token` against a header:** Esri recommends `X-Esri-Authorization` or `Authorization: Bearer` for token-secured GETs so intermediaries do not see the token — <https://developers.arcgis.com/documentation/security-and-authentication/reference/http-header-authentication/> (read through search; the page body did not fetch). The static basemap tiles service documents both forms — <https://developers.arcgis.com/rest/static-basemap-tiles/>. This connector uses `token` because it is the form the World Imagery tile URL documents, and an `api_key` target cannot add the `Bearer ` prefix a header needs (that is a `signed` target, unproved here).
- **The newer service:** `static-map-tiles-api.arcgis.com/.../static-basemap-tiles-service/v1/{style}/static/tile/{level}/{row}/{column}`, 512 px PNG, levels 0–22, imagery only as `arcgis/imagery/labels` (labels drawn on). Not used: no plain imagery style. Billing counts tiles on `ibasemaps-api` and `static-map-tiles-api` alike — <https://developers.arcgis.com/rest/static-basemap-tiles/>, <https://location.arcgis.com/pricing/>.
- **Esri attribution:** `Esri, Maxar, Earthstar Geographics, and the GIS User Community` (the item's Acknowledgments) — the OpenLayers page above; the agreement requires an attribution statement on Basemap output (§ 3.1.d.4).
- **Esri max zoom:** the cache schema is defined to level 23 and imagery is cached to 19; levels 20–23 are empty, and a gap inside coverage is a grey "Map data not yet available" tile served as an HTTP 200 PNG — <https://community.esri.com/en/discussion/57565/arcgisonline-services-map-data-not-yet-available>, <https://github.com/NewGraphEnvironment/gq/pull/124> (a recent measurement: level 18 nearly everywhere in BC, 19 in few places). A placeholder is byte-identical to a tile, so this connector cannot tell them apart.
- **Esri bad key:** ArcGIS REST reports `{"error":{"code":498,"message":"Invalid token.","details":[]}}` (498 invalid, 499 required) — <https://esri.github.io/arcgis-rest-js/api/auth/validateAppAccess/>. **The HTTP status of a refused key on this tile endpoint is not established by any page read here**; the connector maps a 401/403 and a 200 carrying the JSON alike. Unproved against the live service (no keyed call was made).
- **Esri terms, caching and proxying** — ArcGIS Location Platform Agreement E204, the November 2025 revision, <https://www.esri.com/content/dam/esrisites/en-us/media/legal/platform/platform-legal.pdf>:
  - § 3.1.d.6: "Neither Customer nor Application Users may scrape, download, or extract Resultant Output, nor cache or store Resultant Output except as outlined herein: A. Customer may allow pre-caching of Resultant Output as permitted by the caching headers (HTTP/1.1 standard or future standard) returned by Location Services to the extent necessary for enabling or optimizing the use of the Customer Application".
  - § 3.1.d.2: "Customer and Application Users may only use Resultant Output from a single request to serve a single Application User within the Customer Application. A single request for Resultant Output may not be used to serve multiple users."
  - § 3.1.d.3: "...only use Resultant Output for visualization purposes and only within Customer Applications."
  - The agreement says nothing of a proxy as such. A proxy that streams each response to the one browser that asked, and caches only as the returned `Cache-Control` permits, reads as inside A. A server cache that answers many users from one upstream request reads against d.2. The tile result carries `cacheControl` and `etag` so a route can honor the former.
- **NAIP tile URL:** `https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}` — <https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer?f=pjson>: 256 px, Web Mercator, `format: MIXED`, `maxScale` 9027.977411 (1:9,028, level 16), LODs defined to 23. Keyless; two live GETs confirmed it: level 16 returned `200 image/jpeg`, 256x256, `cache-control: max-age=86400`, and level 19 returned `404 text/html` (an ArcGIS "Error: Not Found" page).
- **NAIP attribution:** `USDA, USGS The National Map: Orthoimagery` — the service's `copyrightText` (same page, "Data refreshed June, 2024"). USGS-authored data is public domain, with the request to credit the USGS — <https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits>. The page names no usage limit — <https://www.usgs.gov/faqs/what-are-urls-imagery-services-national-map-and-are-they-cached-or-dynamic>.
- **Not used:** `USGSNAIPPlus`, a dynamic ImageServer (`exportImage`, no tile cache, native resolution about 30 cm, blended with state and local high-resolution orthoimagery whose terms are not all public domain) — <https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer>. `services.arcgisonline.com` keyless World Imagery is not licensed for commercial use.
