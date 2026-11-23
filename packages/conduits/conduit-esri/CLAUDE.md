# conduit-esri — package map

`src/index.ts` is the whole connector. `sink.ts` · `test/esri.drive.ts`. Sources and the vendor terms are in the README.

## What bites

- **The caller is a public route.** z, x and y are integers in range for the source or the call is `refused` before any send; the vendor host and path are fixed here. Never build the path from anything else.
- **`no_key` is the fallback cue, and it is `auth_failed` with no status.** Nothing was sent. A refused key is `bad_key`; do not conflate them or a bad key silently serves NAIP.
- **Esri answers a refused key as JSON under a 200**, so a 200 is a tile only when its content-type is an image. A grey "Map data not yet available" tile is a real image at 200 and cannot be told from imagery.
- **The key is the `token` URL parameter**, on the fetched URL and nowhere else. `raw` is never forwarded; keep it that way.
- **Under junction `who` is written by the plugin**; pass `{ who }` only standalone.
- **NAIP stops at level 16**; a descriptor's `maxZoom` says so and the map overzooms.

## Proving a change

`bun run test`: 20 rows, sink only. No keyed call has been made against Esri.
