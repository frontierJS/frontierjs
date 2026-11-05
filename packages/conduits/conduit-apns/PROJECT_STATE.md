# conduit-apns -- state

**New, sink-only, drive green (14 rows).** Split out of `conduit-push` 2026-11-05 (FJS-D1918); written 2026-10-11 from Apple's APNs provider API reference.

- Source: none extracted. Drive green against: the sink. Fixture: none exists.
- Real vendor: never called; no `.p8` in the environment.
- **Risk -- APNs is HTTP/2-only and the sink speaks HTTP/1.1.** Whether Bun 1.4's
  `fetch` negotiates h2 to `api.push.apple.com` has not been measured and is not
  claimed either way; it needs a key. If it does not, every APNs send fails at
  the transport and this package needs an h2 path conduit does not have.
- Framework gaps hit: conduit remints on 401 only and APNs says 403
  (`ExpiredProviderToken`); closed by `FJS-2721`, the signer's `refused`, row
  `apns.expiredProviderToken.remintedByConduit`.
- Unverified: Apple's exact `reason` catalog beyond the documented set (from the
  reference, not a live response).
