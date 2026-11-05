# conduit-hetzner — package map

`src/index.ts` is the whole connector. `sink.ts` · `test/hetzner.drive.ts`.

## What bites

- **`gross`, not `net`**: gross is what the account is billed. The sink's two numbers differ so a wrong read is visible.
- **A label key is a DNS label.** A colon is refused before the send; the mark's spelling is the app's problem, upstream of here.
- **`available` is always true on a location**; what is sold where is `Size.prices`'s keys.
- **A delete answers 200 with an action**, where DO answers 204 with nothing — both are `true`.

## Proving a change

`bun run drive`: 14 rows.
