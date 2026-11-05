# @frontierjs/conduit-apns

Apple Push Notification service over `@frontierjs/conduit`: one target, a
minted ES256 provider token, the send, and the unregistered-device reading.
Split out of `conduit-push` (FJS-D1918): APNs and FCM share no protocol. FCM is
`conduit-google`'s `fcm` module. New, not extracted; written from Apple's HTTP
reference. **Sink-only: no `.p8` exists on this machine and nothing here has
touched Apple.**

## What it covers

| Piece | Where |
| --- | --- |
| target | `apnsTarget({ ref, address? })` -- `{ type: 'signed', signer: 'apns-jwt', ref }`; `APNS_SANDBOX_ADDRESS` for development builds. One target, so `bindApns(conduit)` is one Send |
| token | `apnsTokenResolver({ keyId, teamId, p8 })` mints the ES256 provider JWT on every `get()`; the app wraps it in `withCache({ ttl_ms: APNS_TOKEN_TTL_MS })` (50 min) |
| send | `sendApns(apns, { deviceToken, topic, pushType, payload, id?, expiration?, priority?, collapseId? })` -> `POST /3/device/{token}` with the `apns-*` headers; answers `{ result?: ApnsResult, error?: ApnsFailure }` |
| signer | `apnsSigners` -- `apnsJwtSigner` (`authorization: bearer <jwt>`); spread into `createConduit({ signers })` |
| error mapping | `translate(ConduitError) -> ApnsFailure` -- the table below |
| the 403 | `apnsJwtSigner.refused` names `ExpiredProviderToken`, so conduit remints once; `forgetProviderToken(cachedResolver, ref)` is for a `remint` that survives that, see Traps |
| verifier | none -- Apple does not call back |
| sink | `sink.ts`, `startApnsSink()` on `port: 0`; generates the key and hands it out on the handle |
| drive | `bun run drive` -- 14 rows, sink only |

```ts fragment
createConduit({ signers: { ...apnsSigners }, credentials: byRef({ APNS_KEY: withCache(apnsTokenResolver(key), { ttl_ms: APNS_TOKEN_TTL_MS }) }) })
const apns = bindApns(conduit)   // sendApns(apns, …)
```

## Errors

| APNs reason | HTTP | conduit kind | `ApnsFailure.kind` | retryable |
| --- | --- | --- | --- | --- |
| `BadDeviceToken`, `Unregistered` (+`timestamp`), `DeviceTokenNotForTopic` | 400 / 410 | `client_error` | **`unregistered`** -- delete the token row | no |
| `ExpiredProviderToken` | 403 | `auth_failed`, forgotten and replayed once by conduit | `remint` if the replay is refused too | conduit already did |
| `InvalidProviderToken`, `MissingProviderToken` | 403 | `auth_failed` | `remint` -- see Traps | after `forgetProviderToken`, once the key is fixed |
| `PayloadTooLarge` | 413 | `client_error` | `too_large` | no |
| `TopicDisallowed`, `BadTopic`, `MissingTopic`, `BadPriority`, … | 400 | `client_error` | `refused` | no |
| `TooManyRequests` | 429 | `rate_limited` | `rate_limited` + `retryAfterMs` | by the caller, after the wait |
| `InternalServerError` | 500 | `server_error` | `server_error`, `indeterminate` | no -- not keyed |

A push is never keyed and never `replayable`: APNs collapses nothing by
itself, so a lost response is `indeterminate` and there is no read that
resolves it. The app's `sentAt` on its own row is the only evidence.

## Chaos the sink owns

`/_sink/arm` with `{ lost }`, `{ rateLimit: { retryAfter } }`, `{ failNext }`,
`{ expireProviderToken }` (next call 403 once). Device tokens ending `0000` are
`BadDeviceToken`, `4100` is `Unregistered` with a timestamp; a topic ending
`.forbidden` is `TopicDisallowed`. The same `apns-id` twice is one push.

## Traps

- **Apple says 403 for an expired provider token**, and a 403 is otherwise the
  credential accepted. `apnsJwtSigner.refused` names `ExpiredProviderToken`,
  so conduit forgets the cached token and replays once on a fresh one
  (`FJS-2721`). `InvalidProviderToken` is not reminted: it means a wrong key or
  team, and each remint spends one of Apple's token updates.
- **The token is minted in the resolver, never the signer.** A signer runs per
  attempt and holds nothing; minting there is a fresh JWT per request, which
  Apple answers with `TooManyProviderTokenUpdates`.
- **A 4,097-byte payload is refused here**, before the send, by byte count of
  the serialized JSON -- Apple counts bytes, and a payload with a multi-byte
  character is bigger than its `length`.
- **APNs is HTTP/2-only.** The sink is HTTP/1.1. Whether Bun's `fetch`
  negotiates h2 to `api.push.apple.com` is unmeasured here; see `PROJECT_STATE.md`.
