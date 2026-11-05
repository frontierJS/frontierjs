# conduit-plausible — package map

`src/index.ts` is the whole connector. `sink.ts` · `test/plausible.drive.ts` · `test/fixture/README.md`.

## What bites

- **`replayable: true` on a POST** is deliberate and is the point of the package.
- **A 429 with no header is retried by conduit before the caller sees `quota`**; the sink arms `quota: n` for that many answers so the drive can show it.
- **`limit` above 10,000 is refused locally**; the vendor clamps it in silence.

## Proving a change

`bun run drive`: 8 rows. Fixture: Plausible CE, docker, unproved here.
