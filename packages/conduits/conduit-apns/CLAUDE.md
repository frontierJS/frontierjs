# conduit-apns -- package map

`src/index.ts` (target, `bindApns`, ES256 resolver, signer, `sendApns`) ·
`src/jwt.ts` (the ES256 mint over WebCrypto) · `src/errors.ts` (the one reader
of `error.raw`) · `src/types.ts` · `sink.ts` · `test/apns.drive.ts`.

Split from `conduit-push` (FJS-D1918): APNs and FCM share no protocol. FCM is
`conduit-google`'s `fcm` module. Notifications maps both onto one message; this
package keeps its own `ApnsResult` and `ApnsFailure`.

## What bites

- **`translate()` is the only place that reads `error.raw` or `meta.status`.**
  A 400 is `BadDeviceToken` or `TopicDisallowed`; only the body says which.
- **`apnsJwtSigner.refused` names `ExpiredProviderToken` and nothing else**
  (FJS-2721). Conduit then forgets the cached token and replays once. Adding
  `InvalidProviderToken` remints on every send under a wrong key, and Apple
  rate-limits token updates. Never move the mint into the signer, for the same
  reason.
- **The sink verifies with `node:crypto` (`ieee-p1363` for ES256).** The
  connector mints with WebCrypto. Keep them apart: a sink that imported the
  connector's `signJwt` would agree with it by construction.
- **`reset` keeps the key.** Later sections send on the token the first
  section bought.

## Proving a change

`bun run drive`. Green is 14 rows; there is no fixture.
