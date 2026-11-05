# conduit-stripe — package map

Stripe's dialect: form bodies, a bearer key, a pinned version, its own
webhook scheme. `src/index.ts` (target + calls) · `src/errors.ts` (the one
reader of `error.raw`) · `src/verify.ts` (pure) · `src/tax.ts` (Stripe Tax, exported as `tax`) · `sink.ts` · `test/stripe.drive.ts`.

## What bites

- **`translate()` is the only place that reads `error.raw`.** Conduit grades
  by status; a 402 decline is `client_error` and the body says `card_error`.
- **The sink parses the form by hand** on purpose — a decoder built from
  conduit's encoder agrees with it by construction.
- **Reset keeps the intents.** The drive's later sections refund what the
  first section made; a reset that cleared them made four rows fail as 404s.
- **The rates in the sink's tax paths are the sink's**, not any jurisdiction's. `tax.isExpired` takes the clock; `taxExpiresInSeconds: 1` is how the drive reaches the 90-minute case.

## Proving a change

`bun run drive`. Green means 26 rows; there is no fixture.
