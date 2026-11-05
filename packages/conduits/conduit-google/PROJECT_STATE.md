# conduit-google — state

Renamed from `conduit-google-maps` 2026-11-05 (FJS-D1916); Maps is the first module (`src/maps/`). `fcm` joined 2026-11-05 from `conduit-push` (FJS-D1918); sink split into `sink/maps.ts` and `sink/fcm.ts`, one port.


**New, sink-only, drive green (32 rows: 22 maps, 10 fcm).**

- Drive green against: the sink, both hosts on one port. Fixture: none exists.
- Real vendor: never called; no key in the environment. Google's error
  wording and `details[].reason` values are from memory, unverified against a
  real project.
- Legacy Geocoding built over `api_key { query: 'key' }` (`FJS-2727`, G3
  closed); three `geocoding.*` rows. Nominatim named as the free fallback, not built.
- Places, Routes and Geocoding are still three targets, one bundle; `origins` (`FJS-D939`) could fold
  them into one, and every call would then name its host. Not done.
- Amendments to `CONTRACT.md`: C1 (one builder, one descriptor per
  origin sharing a ref; now the bundle); C5 (a paid read is `replayable: true`, the cost
  stated).

## fcm

- Source: none extracted; written from FCM HTTP v1 and Google's service-account
  OAuth references. Real vendor: never called; no service account in the environment.
- Closed from the push run: the exchange is a send through its own target
  (`FJS-2722`, row `fcm.tokenEndpointDown.isRetryableAuthFailed`); `byRef()`
  (`FJS-2724`) carries it beside any other minted credential.
- Unverified: FCM's `details[].errorCode` placement on every status (from the
  reference, not a live response).
