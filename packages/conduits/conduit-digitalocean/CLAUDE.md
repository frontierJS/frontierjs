# conduit-digitalocean — package map

`src/index.ts` is the whole connector: target, calls, `translate`, `toSize`.
`sink.ts` · `test/digitalocean.drive.ts`.

## What bites

- **The 404 test is the STATUS, not the kind** — every 4xx is `client_error`.
- **`price_monthly` is a float of dollars**; `toSize` is the one place it becomes minor units, via `minorUnits('USD')`.
- **A create answers `new` with no address.** `starting` here; the caller waits for a `running` read.
- **A 2xx with no droplet id is `indeterminate`, never `refused`**: the vendor accepted it, the machine may exist, and only the tag finds it.

## Proving a change

`bun run drive`: 13 rows.
