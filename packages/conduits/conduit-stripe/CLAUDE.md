# conduit-stripe — package map

Stripe's dialect: form bodies, a bearer key, a pinned version, its own
webhook scheme. `src/index.ts` (target + calls) · `src/errors.ts` (the one
reader of `error.raw`) · `src/verify.ts` (pure verifier and `stripeDialect`) · `src/tax.ts` (Stripe Tax, exported as `tax`) · `sink.ts` · `test/stripe.drive.ts`.

## What bites

- **`translate()` is the only place that reads `error.raw`.** Conduit grades
  by status; a 402 decline is `client_error` and the body says `card_error`.
- **The sink parses the form by hand** on purpose — a decoder built from
  conduit's encoder agrees with it by construction.
- **Reset keeps the intents.** The drive's later sections refund what the
  first section made; a reset that cleared them made four rows fail as 404s.
- **The dialect checks the signature alone.** `verifyStripeSignature` also refuses a body that is not an event; the dialect must not, because conduit answers a non-event 200 and a 401 retries for days.
- **Connect's controller values are permanent on an account** (`FJS-D2200`): they are the `STANDARD_LIKE_CONTROLLER` constant, never an argument. No input type offers `PLATFORM_FEE_KEYS`, and `refusePlatformFee` refuses them at runtime; a new charge-creating call runs it on both its input and its built body.
- **A connected account's events are signed with the Connect endpoint's secret**, a different `whsec_…` at a different path, so the app registers a second Receiver under its own provider; `verifyStripeSignature` and `stripeDialect` stay the one verifier and surface `account`.
- **The rates in the sink's tax paths are the sink's**, not any jurisdiction's. `tax.isExpired` takes the clock; `taxExpiresInSeconds: 1` is how the drive reaches the 90-minute case.

## Proving a change

`bun run drive`. Green means 42 rows; there is no fixture.
