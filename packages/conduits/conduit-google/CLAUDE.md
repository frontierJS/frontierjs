# conduit-google — package map

The project-credential Google products (an API key or a service account); the
user's delegated OAuth grant is `conduit-gmail`. Two modules, each exported as
a namespace and a subpath: `maps` (`src/maps/`, `./maps`) and `fcm`
(`src/fcm/`, `./fcm`; from `conduit-push`, FJS-D1918). Everything below is the
maps module's until § FCM.

Google's dialect: a key header, a per-request field mask that is the price,
gRPC status words inside a JSON envelope, `{}` for nothing found. Three hosts,
three targets, one builder (`googleMapsTargets`) and one bind (`bindGoogleMaps`). `src/maps/index.ts` (targets + calls + the mask check) ·
`src/maps/errors.ts` (the one reader of `error.raw`) · `src/maps/cache-key.ts` ·
`sink.ts` (starts every module on one port) · `sink/maps.ts` · `sink/fcm.ts` · `test/google.drive.ts`.

## What bites

- **`translate()` is the only place that reads `error.raw`.** Conduit grades
  by status and Google by `error.status`; a 403 is `auth_failed` to conduit
  and `forbidden` here, a bad key is a 400 and `auth_failed` here.
- **A missing mask is refused locally AND by the sink.** The local check is
  the feature; the sink's 400 is what proves the check is about something.
  Drop `headers: { [FIELD_MASK_HEADER]: mask }` and seven rows fail.
- **Google answers `{}` for no results**, never `places: []`. Read `?? []`.
- **A Duration is `"1234s"`**, a string; `parseDuration` is the one parser.
- **Three sends, one bundle.** Every call takes `bindGoogleMaps()`'s result
  and picks `places`, `routes` or `geocoding` itself; a Routes path sent to
  the Places target is a 404 at Google, so a caller is never handed the choice.

## Proving a change

## FCM

`src/fcm/index.ts` (targets `{ api, token }`, `bindFcm`, `fcmTokenResolver`,
`bearerSigner`, `sendFcm`, `forgetAccessToken`) · `src/fcm/jwt.ts` (the RS256
mint over WebCrypto) · `src/fcm/errors.ts` (the one reader of `error.raw` for
FCM) · `src/fcm/types.ts`. APNs is `conduit-apns`; notifications maps both
onto one message, so `FcmResult` and `FcmFailure` are this module's own.

- **`translate()` (fcm) is the only place that reads FCM's `error.raw`.** The
  reason is `error.details[].errorCode`, not the HTTP status.
- **The exchange is a send through the `token` target**, not a `fetch` in the
  resolver (FJS-2722): a token endpoint outage is a retryable `auth_failed`
  with nothing sent to FCM. `serviceAccount.token_uri` is ignored on purpose.
- **The sink verifies the assertion with `node:crypto`**; keep it apart from
  the connector's WebCrypto mint.
- **The sink's control endpoints are per module** (`/maps/_sink/*`,
  `/fcm/_sink/*`) because `rateLimit`, `failNext` and `lost` collide.
  `/_sink/reset` clears both.

## Proving a change

`bun run drive`. Green means 32 rows (22 maps, 10 `fcm.`); there is no fixture and no key.
