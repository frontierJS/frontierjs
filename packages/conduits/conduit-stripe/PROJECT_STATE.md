# conduit-stripe — state

**Extracted, sink-only, drive green (37 rows).** 2026-10-11; Stripe Tax folded in 2026-11-05 (FJS-D1915); Connect added 2026-11-16 (FJS-4375, FJS-D2200): v1 controller properties behaving like Standard, account links, account status, direct charges and Checkout on a connected account, Connect webhooks through the one verifier.

- Source: `example/api/src/providers/stripe/` at `6ad199f2`.
- Drive green against: the sink. Fixture: none exists.
- Real vendor: never called; no key in the environment.
- Gaps: none open. Finding for `CONTRACT.md`: the version header and the
  idempotency header name belong on the target, not per call (moved here).
- FJS filed: none.
