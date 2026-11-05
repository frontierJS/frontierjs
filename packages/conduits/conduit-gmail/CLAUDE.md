# conduit-gmail — package map

Gmail's dialect over conduit; the sync engine stays in the app.
`src/index.ts` (target, calls, validators) · `src/errors.ts` (the one reader of
`error.raw`, the status and the headers) · `src/mime.ts` (RFC 2822 builder,
the threading contract) · `src/parse.ts` (Message resource → the app's
shape) · `src/history.ts` (thread discovery, the history walk, the forward-only
watermark) · `src/push.ts` (the envelope, the bearer's verifier over
conduit-oidc's primitives) · `sink.ts` · `test/gmail.drive.ts`.

## What bites

- **`translate()` is the only place that reads `error.raw` or the status.**
  `listHistory` renames the failure's `gone` to `history_gap` off the KIND,
  never off the status.
- **Four things are a 403** and conduit calls every one `auth_failed` without
  replaying it; only `reason` tells scope, policy, quota and units apart.
- **`verifyIdToken` refuses a real push token** on `azp`; `verifyPushBearer`
  here keeps oidc's signature half and checks Google's push claims itself.
- **The sink parses MIME by hand** so a drift in `buildMime` is a refusal.
  Do not import the builder into the sink in reverse.
- **`listThreadIds` discards message ids on purpose**: ingesting from a list
  manufactures false roots. The thread fetch supersedes them.
- **The drive's resolver has `invalidate`.** With the static one a 401 is not
  replayed and `revoked.isAuthFailedOnce` reads 1 attempt.
- **History ids are strings.** `advanceHistoryId` compares BigInt; nothing
  computes with one.

## Proving a change

`bun run drive`. Green means 41 rows; there is no fixture. If it fails on
`Signer`/`address_from`, run `./link.sh` from the workspace root.
