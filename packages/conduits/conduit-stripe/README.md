# @frontierjs/conduit-stripe

Stripe over `@frontierjs/conduit`: payment intents, refunds, and the webhook
signature. Extracted from `frontierjs/example/api/src/providers/stripe/`
(`index.ts`, `sink.ts`) and `example/web/test/verify-stripe.mjs` at commit
`6ad199f2`. The source app keeps its copy.

## What it covers

| Piece | Where |
| --- | --- |
| target builder | `stripeTarget({ ref?, address? })` — bearer, `encoding: 'form'`, `Stripe-Version` and `Idempotency-Key` on the target |
| calls | `createPaymentIntent(send, …)` (replayable, unkeyed unless asked), `createRefund(send, …)` (key required) |
| payload types | `PaymentIntent`, `StripeRefund`, `StripeEvent`, `StripeErrorBody` |
| error mapping | `translate(ConduitError) → StripeFailure` — the table below |
| verifier | `verifyStripeSignature({ rawBody, header, secret, now })` — pure |
| sink | `sink.ts`, `startStripeSink()` on `port: 0` |
| tax | `tax` namespace (`src/tax.ts`) — Stripe Tax, below |
| drive | `bun run drive` — 26 rows (16 stripe, 10 `tax.*`), sink only; no conforming Stripe exists |

`send` is `bindSend(conduit)`: the connector never holds an app.

## Errors

| vendor | HTTP | conduit kind | `StripeFailure.kind` | retryable |
| --- | --- | --- | --- | --- |
| `card_error` | 402 | `client_error` | `declined` (+ `decline_code`) | no |
| `invalid_request_error` | 400/404 | `client_error` | `refused` | no |
| `idempotency_error` | 400 | `client_error` | `idempotency_conflict` | no |
| `api_key_invalid` | 401 | `auth_failed` | `auth_failed` | no |
| `rate_limit_error` | 429 | `rate_limited` | `rate_limited`, `retryAfterMs` | yes |
| `api_error` | 500 | `server_error` | `server_error` | yes |

## Chaos the sink owns

`/_sink/arm` with `{ failNext }`, `{ lost }`, `{ rateLimit: { retryAfter } }`,
`{ deliverTwice }`; amount `4242` is the decline; a wrong content-type is
refused by name (the drive's negative control).

## Traps

- **An unkeyed intent is `replayable: true`** — it moves no money, and after a
  decline the next attempt must be a new intent, which a key would hand back.
- **A refund key is the caller's**, never minted here: a uuid would be unique
  and guard nothing.
- **The verifier takes `now`**; a clock read inside it cannot be moved by a test.

## Tax

Stripe Tax is a module of this package, not a second connector: `import { tax } from '@frontierjs/conduit-stripe'`.
It rides the same target, form encoding and key (`stripeTarget`, `bindSend`)
and adds the three tax calls and the rule around them.

| Piece | Where |
| --- | --- |
| calls | `tax.createCalculation` (replayable, unkeyed), `tax.createTransaction` (key required), `tax.createReversal` (key required), `tax.isExpired(calc, now)` |
| error mapping | `tax.translate`: stripe's, then `customer_tax_location_invalid` to `address_unresolvable`, `tax_id_invalid`, `resource_missing` on a calculation to `expired` |
| sink | the same `startStripeSink()`; rates are the sink's: US by state, EU VAT, reverse charge on an `eu_vat` id; `taxExpiresInSeconds` |

**The calculation is recorded at the sale and the transaction is created from
it at capture. Nothing recomputes.** A filing is made against what was
charged. A calculation expires (90 minutes at Stripe); past it the answer is
`expired` and the caller recalculates rather than filing against a stale
number. `tax.createTransaction` and `tax.createReversal` are irreversible in
the filing sense, so both require the caller's idempotency key, as a refund does.

| `code` | `TaxFailure.kind` |
| --- | --- |
| `customer_tax_location_invalid` | `address_unresolvable` — ask for a better address |
| `tax_id_invalid` | `tax_id_invalid` |
| `resource_missing` naming a calculation | `expired` — recalculate |
