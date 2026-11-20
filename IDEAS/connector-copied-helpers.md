---
id: connector-copied-helpers
status: proposed
dated: 2026-11-19
---

# Proposal — the helpers connectors copy rather than import

**Status: PROPOSAL. Nothing here is built.** Left over from `FJS-2966`'s
duplicate-name census: two families of connector code that the `ws:exports`
ratchet lists as duplicated names (the phone-number pair; the signers sit below
any package root, where it cannot see them). Each is copied in full, so a fix
to one copy misses the others.

## Phone numbers — `toE164` and `keywordOf`

`toE164(input, defaultCountry?)` is in `conduit-quo/src/index.ts`,
`conduit-twilio/src/index.ts` and `conduit-telnyx/src/index.ts`. The three
bodies match apart from the vendor name in the error message.
`keywordOf(text)` (STOP/START/HELP) is in `conduit-twilio/src/index.ts` and
`conduit-telnyx/src/verify.ts`, and the two are identical.

**Candidate:** an `sms` helper owning both, the vendor name passed in for the
message. **Waits on** a home: no package holds a phone-number rule today, and
a fourth SMS connector, or an app normalizing numbers outside a connector, is
what asks for one.

## Push JWT signers — apns and fcm

`conduit-apns/src/jwt.ts` (ES256, Apple's provider token) and
`conduit-google/src/fcm/jwt.ts` (RS256, a service-account assertion) each
carry their own `b64url`, PKCS8 import and `signJwt`.

**Candidate:** import them from `conduit-oidc/src/jwt.ts`, which already
exports `signJwt(alg, key, header, payload)` for both algorithms, plus `b64url`
and `importEs256Pkcs8`. **Waits on nothing:** the owner exists, so this is
adoption, the way gmail takes `DEFAULT_CLOCK_SKEW_SECONDS` from it. An RS256
PKCS8 import is the one thing it lacks. The `r || s` signature trap in apns's
header comment moves with the code.

## Next

1. The signers: move apns and fcm onto `conduit-oidc`'s `signJwt`, and prove it with
   each connector's drive. The `ws:exports` ratchet cannot see this pair, since
   neither connector exports them from its root.
2. Phone numbers: rule where an `sms` helper lives (`decision-rules`: a new
   noun) when the fourth asker arrives.
