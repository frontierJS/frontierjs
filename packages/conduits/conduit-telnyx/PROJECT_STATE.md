# conduit-telnyx — state

**Texts, call control, credentials and the media stream; sink-only drive green (28 rows).**

- Source: extracted from serpgrid's provider (quo's is near-identical), which ran against the live carrier. Apps still carry their own copies; moving serpgrid, quo, ela and sstime onto this is the next step (`IDEAS/prototype-twins.md` Phase 3).
- Drive green against: the sink. Fixture: none exists. Real vendor not called from here.
- Unverified: the error codes in `src/errors.ts` other than `40300` and `10039`. The STOP-keyword set is CTIA's. The media stream's bidirectional payload shape (raw PCMU assumed).
- Open: `credentialToken` bypasses conduit until a send can accept an untyped text body.
- Finding for `CONTRACT.md`: a second signature family (Ed25519, asymmetric, a public key not a shared secret) fits the same pure-verifier shape as Stripe's HMAC.
- FJS filed: none.
