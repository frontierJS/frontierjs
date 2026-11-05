# conduit-microsoft — package map

Microsoft's identity platform and Graph mail as a dialect over conduit; the
sync engine stays in the app (`FJS-D1463`). `src/index.ts` (targets, `bindMicrosoft`,
the calls, validators, login) · `src/errors.ts` (the one reader of `error.raw`,
the status and the headers; two vendors, one table) · `src/resolver.ts` (the
per-grant token resolver and the cross-process lock; `GrantStore`) ·
`src/subscriptions.ts` (create/renew/delete, `ensureSubscription`) ·
`src/receive.ts` (the two dialects, `subscriptionIdOf`, `handshake`) ·
`src/types.ts` · `sink.ts` (ELA's stand-in, renamed) · `test/microsoft.drive.ts`.

## What bites

- **The refresh token rotates and the spent one is dead.** Any path that
  refreshes outside `microsoftTokenResolver` — a second resolver without the
  shared store, a hand-rolled retry on the login target — burns the grant.
  The login target has `retry_limit: 0` for this reason; do not raise it.
- **`GrantStore.update` is a compare-and-set on `refreshing`**, deep-equal
  against `expect`. A store that ignores `expect` passes every row but the
  lock ones.
- **`bindMicrosoft` needs graph's `address`, not just its id**: `deltaNext`
  and the conversation pager read a link against `ms.graphAddress` to turn it
  into a path and to refuse one off the origin.
- **`resourceData.id` is the REST id** even under `Prefer: ImmutableId`.
  Never key a row on it; fetch and key on the immutable `id`.
- **`subscriptionIdOf` refuses a batch naming two subscriptions.** Graph
  sends one per POST; a mixed batch is not Graph.
- **The handshake is a raw route.** `handshake(url)` must run BEFORE
  `app.conduit.receive()` on the path, or every create fails validation.
- **The sink parses MIME by hand** (`parseMime`), so a drift in the app's
  MIME builder is a refusal. Do not import a builder into the sink.
- **`sink.reset()` keeps `writes()`** and clears `received`, fails, drops and
  knobs; the drive counts calls off `sink.received.length`.

## Proving a change

`bun run drive`. Green means 33 rows; there is no fixture. If it fails to
resolve `@frontierjs/conduit`, run `./link.sh` from the workspace root.
