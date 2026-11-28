# conduit-stripe — state

**Extracted, sink-only, drive green (48 rows).** 2026-10-11; Stripe Tax folded in 2026-11-05 (FJS-D1915); Connect added 2026-11-16 (FJS-4375, FJS-D2200): v1 controller properties behaving like Standard, account links, account status, direct charges and Checkout on a connected account, Connect webhooks through the one verifier. Card authorization and disputes added 2026-11-27 for grouppi's lending deposits (FJS-D2422; `IDEAS/group-lending.md` 4.5 and the connector half of 6.1): `captureMethod: 'manual'` on an intent and a Checkout session, `capturePaymentIntent` (whole or part), `cancelPaymentIntent`, the `charge.dispute.*` objects typed, and the sink's matching routes and events.

- Source: `example/api/src/providers/stripe/` at `6ad199f2`.
- Drive green against: the sink. Fixture: none exists.
- Real vendor: never called; no key in the environment.
- Gaps: the sink's held Checkout session completes `paid`, and its cancel sends `payment_intent.canceled` alone; neither is checked against a real test-mode run yet. The sink does not expire a hold after 7 days. Finding for `CONTRACT.md`: the version header and the
  idempotency header name belong on the target, not per call (moved here).
- FJS filed: none.
