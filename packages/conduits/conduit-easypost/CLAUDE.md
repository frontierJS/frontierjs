# conduit-easypost — package map

`src/index.ts` is the whole connector. `sink.ts` · `test/easypost.drive.ts`.

## What bites

- **`buyLabel` reads back before anybody retries**; the row `buy.lostResponseRecoveredByReadBack` counts one buy and one read.
- **The verified address object is sent whole**, so the label carries the carrier's spelling, not the id of the one asked for.
- **Customs is refused locally** when `to.country !== from.country` and no `customs_info` was given.
- **The sink's rates are the sink's.** The drive asserts conversion, not postage.

## Proving a change

`bun run drive`: 15 rows.
