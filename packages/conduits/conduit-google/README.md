# @frontierjs/conduit-google

The Google products an app reaches with its own project credential (an API key
or a service account). `conduit-gmail` is the user's delegated OAuth grant;
this package is not. Two modules: **maps**, `import { maps } from
'@frontierjs/conduit-google'` or `from '@frontierjs/conduit-google/maps'`, and
**fcm** (below), `{ fcm }` or `/fcm`.

## Maps

Google Maps Platform over `@frontierjs/conduit`: geocode an address, read a
place, compute a drive time. Outbound only; Google signs nothing back.

## What it covers

| Piece | Where |
| --- | --- |
| target builder | `googleMapsTargets({ ref?, placesAddress?, routesAddress?, geocodingAddress? }) → { places, routes, geocoding }` — `api_key` in `X-Goog-Api-Key`, ref `GOOGLE_MAPS_API_KEY`; `geocoding` is legacy Geocoding, `api_key` with `query: 'key'` (`FJS-2727`) |
| calls | `geocode(maps, { address })`, `searchText(maps, { query, fieldMask })`, `placeDetails(maps, { id })`, `driveTime(maps, { origin, destination })`, `geocodeLegacy(maps, { address, region? })` — every outcome a 200, graded by `status` |
| payload types | `Place`, `LatLng`, `Route`, `Waypoint`, `GoogleErrorBody` |
| error mapping | `translate(ConduitError) → GoogleMapsFailure` — the table below |
| cache key | `cacheKey(address, { region? })`, `normalizeAddress(address)` — the connector caches nothing |
| verifier | none; Google has no webhooks here |
| sink | `sink.ts`, `startGoogleSink()` on `port: 0`; `sink/maps.ts` answers the three Maps hosts, `sink/fcm.ts` FCM and the token endpoint |
| drive | `bun run drive` — 32 rows (22 maps, 10 `fcm.`), sink only; no fixture exists |

`maps` is `bindGoogleMaps(conduit, targets)`, one `Send` per target: the
connector never holds an app, and every call takes the bundle and picks the
target for ITS host.

## Three targets from one builder

Places (New) is `places.googleapis.com`, Routes is `routes.googleapis.com` and
legacy Geocoding is `maps.googleapis.com`. A `TargetDescriptor` has one
`address`, so the three APIs are three targets, `provider:google-maps:places`,
`…:routes` and `…:geocoding`. One builder returns all three because they share the one fact that matters: the key. A Maps
Platform key is one credential, enabled per API on the project — which is why
a `PERMISSION_DENIED` names the API and not the key, and why the
descriptors carry the same `ref`. A build that uses one API registers that
target and ignores the others.

## The field mask

Every Places and Routes request carries `X-Goog-FieldMask`, per REQUEST, and
the fields named decide the SKU billed. The connector refuses, before sending:

- no mask — Google answers a 400 and the round trip is wasted;
- `*` or `foo.*` — Google accepts it and bills the most expensive tier.

`GEOCODE_FIELD_MASK` (`places.id,places.formattedAddress,places.location`) is
the Essentials tier; `placeDetails` and `driveTime` have their own defaults
and take a mask when the app needs more. The sink records the SKU each mask
would cost, so the drive can see no wildcard left the process.

## Answers that are not errors

- **`geocode` → `{ answer: 'zero_results' }`** when the address is not on the
  map. Google spells it `{}` on a 200 (`places` absent, not empty); the
  connector reads both. An app caches a zero as readily as a hit.
- **`driveTime` → `{ answer: 'no_route' }`** when `routes` is absent.

## Errors

| Google `error.status` | HTTP | conduit kind | `GoogleMapsFailure.kind` | retryable |
| --- | --- | --- | --- | --- |
| `INVALID_ARGUMENT` | 400 | `client_error` | `refused` | no |
| `INVALID_ARGUMENT` + `reason: API_KEY_INVALID` | 400 | `client_error` | `auth_failed` | no |
| `PERMISSION_DENIED` (`SERVICE_DISABLED`, key restricted) | 403 | `auth_failed` | `forbidden` | no |
| `NOT_FOUND` | 404 | `client_error` | `gone` | no |
| `RESOURCE_EXHAUSTED` | 429 | `rate_limited` | `rate_limited`, `retryAfterMs` | yes |
| `UNAVAILABLE` | 503 | `server_error` | `server_error` | yes |

A Google 429 is a per-minute quota and almost never carries `Retry-After`;
with none the connector supplies `RATE_LIMIT_FALLBACK_MS` (60 s) so the caller
is not refused again a second later. A `forbidden` is the project's, not the
key's: conduit does not forget the credential on a 403 and the next call
goes out signed.

## Cost, replay, and the cache

Every call is a READ that Google charges per request. All three are sent
`replayable: true` (the GET is replayed by conduit anyway): a 503 or a lost
response is retried, and the cost of a retry is a second charge, never a
second write. There is no indeterminate state to resolve.

The connector does NOT cache. The cache of a paid lookup is the app's (C12);
the connector hands over `cacheKey(address)` so two writers of the same
address collide. It folds case, whitespace, comma spacing and trailing
punctuation and nothing geographic — `St` and `Street` are two keys, because
guessing that they are one is a geocode. Store the `zero_results` answer too.

## Not built, and why

- **Nominatim** (OpenStreetMap) is the free fallback: the same `geocode()`
  signature behind a second target, a different API. Not a protocol Google
  shares, so not here.

## Chaos the sink owns

`/maps/_sink/arm` with `{ lost }`, `{ rateLimit: { retryAfter?, times? } }`,
`{ failNext }` (503 UNAVAILABLE), `{ denyApi: 'places' | 'routes' }` (403
PERMISSION_DENIED naming the API). A request with no field mask is refused
with Google's 400 — the drive's negative control: strip the local check and
the sink refuses.

## FCM

Firebase Cloud Messaging (HTTP v1) over `@frontierjs/conduit`, authenticated
with a Google service account, which is why it is a module here and not a
package: the credential is the project's. APNs is `@frontierjs/conduit-apns`
(FJS-D1918, split from `conduit-push`); the two share no protocol, and
notifications maps both onto one message. New, not extracted; written from
Google's references. **Sink-only: no service account exists on this machine
and nothing here has touched Google.**

| Piece | Where |
| --- | --- |
| targets | `fcm.fcmTargets({ projectId, ref, address?, tokenUrl?, id? })` -> `{ api, token }`. `api` is `{ type: 'signed', signer: 'bearer', ref }`, one per project; `token` is Google's token endpoint (`auth: none`, `encoding: form`), one id for the process. `bindFcm(conduit, targets)` -> `{ api, token }` Sends |
| token | `fcmTokenResolver(serviceAccount, { send, tokenUrl? })` mints an RS256 assertion and exchanges it through `send`, the bundle's `token` Send; a failed exchange throws `MintError`, so the FCM send is `auth_failed` with the exchange's `retryable`. Wrap in `withCache({ ttl_ms: FCM_TOKEN_TTL_MS })` (55 min) |
| send | `sendFcm(fcm, projectId, { token \| topic \| condition, notification, data })` -> `POST /v1/projects/{p}/messages:send`; answers `{ result?: FcmResult, error?: FcmFailure }` |
| signer | `fcmSigners` -- `bearerSigner` (`Authorization: Bearer <token>`); spread into `createConduit({ signers })` |
| error mapping | `translate(ConduitError) -> FcmFailure` -- the table below |
| verifier | none -- FCM does not call back |
| sink | `sink/fcm.ts`, generates the RSA key and hands the `serviceAccount` out on the handle; control under `/fcm/_sink/` |

The resolver's `send` is bound late -- `req => fcm.token(req)` -- since the
resolver is handed to the conduit it sends through. `forgetAccessToken(cached,
ref)` drops the cached token so the next send exchanges again.

| FCM code | HTTP | conduit kind | `FcmFailure.kind` | retryable |
| --- | --- | --- | --- | --- |
| `UNREGISTERED` | 404 | `client_error` | **`unregistered`** -- delete the token row | no |
| `INVALID_ARGUMENT` | 400 | `client_error` | `refused` | no |
| `SENDER_ID_MISMATCH`, `PERMISSION_DENIED`, `THIRD_PARTY_AUTH_ERROR` | 403 | `auth_failed` | `forbidden` | no |
| `UNAUTHENTICATED` | 401 | `auth_failed` | -- conduit forgets the token and replays once | once |
| `QUOTA_EXCEEDED` | 429 | `rate_limited` | `rate_limited` + `retryAfterMs` | by the caller |
| `UNAVAILABLE`, `INTERNAL` | 503 / 500 | `server_error` | `server_error` | no -- not keyed |
| token exchange refused (`invalid_grant`) | -- | `auth_failed` | `auth_failed`; the reason is `resolver.lastRefusal()` | no |

A send is never keyed and never `replayable`: FCM has no idempotency header and
a retried send is a second notification, so a lost response is `indeterminate`
with no read to resolve it.

Sink chaos, under `/fcm/_sink/arm`: `{ lost }`, `{ rateLimit: { retryAfter } }`,
`{ failNext }`, `{ expireAccessToken }` (next FCM call 401 once), `{ invalidGrant }`
(next `/token` 400 once), `{ tokenUnavailable }`. Device tokens ending `0000`
are `UNREGISTERED`, `9999` is `SENDER_ID_MISMATCH`.

**A refused exchange (`invalid_grant`) is a permanent `auth_failed`; an
exchange that could not be made (503, timeout, the token target's breaker
open) is a retryable one.** Both send nothing to FCM. `error.raw` is the token
target's own error.
