# @frontierjs/conduit-stripe

Stripe over `@frontierjs/conduit`: payment intents, refunds, Checkout, Stripe
Connect (accounts that behave like Standard, direct charges), and the webhook
signature. Extracted from `frontierjs/example/api/src/providers/stripe/`
(`index.ts`, `sink.ts`) and `example/web/test/verify-stripe.mjs` at commit
`6ad199f2`. The source app keeps its copy.

## What it covers

| Piece | Where |
| --- | --- |
| target builder | `stripeTarget({ ref?, address? })` — bearer, `encoding: 'form'`, `Stripe-Version` and `Idempotency-Key` on the target |
| calls | `createPaymentIntent(send, …)` (replayable, unkeyed unless asked; `captureMethod: 'manual'` holds the amount), `retrievePaymentIntent(send, { id, account? })` (read one back, for the `client_secret` an app never stores; `id` must be `pi_…`), `createRefund(send, …)` (key required), `createCheckoutSession(send, …)` (replayable, unkeyed unless asked; `captureMethod: 'manual'` holds it), `capturePaymentIntent(send, { id, amountMinor?, account?, key })` (key required), `cancelPaymentIntent(send, { id, account?, key })` (key required), `retrieveBalanceTransaction(send, { id, account? })` (Stripe's fee on a charge: the `txn_…` its `balance_transaction` names) — each takes `account` for a direct charge |
| connect | `createConnectedAccount` (key required), `createAccountLink`, `retrieveAccountStatus`, `accountStatus(account)`, `STANDARD_LIKE_CONTROLLER`, `PLATFORM_FEE_KEYS` — below |
| payload types | `PaymentIntent`, `StripeRefund`, `StripeCharge`, `StripeDispute`, `CaptureMethod`, `StripeBalanceTransaction`, `StripeEvent`, `StripeCheckoutSession`, `StripeInvoice`, `StripeAccount`, `StripeAccountLink`, `StripeAccountStatus`, `StripeErrorBody` |
| error mapping | `translate(ConduitError) → StripeFailure` — the table below |
| verifier | `verifyStripeSignature({ rawBody, header, secret, now })` — pure; `{ ok, event, account }` |
| dialect | `stripeDialect` for `app.conduit.receive()`; `ev.account` names the connected account; `stripeObject(ev, 'invoice.paid')` narrows the event's object by type |
| sink | `sink.ts`, `startStripeSink()` on `port: 0` |
| tax | `tax` namespace (`src/tax.ts`) — Stripe Tax, below |
| drive | `bun run drive` — 48 rows (20 stripe, 12 `connect.*`, 5 `auth.*`, 1 `dispute.*`, 10 `tax.*`), sink only; no conforming Stripe exists |

`send` is `bindSend(conduit)`: the connector never holds an app.

## Receiving

```ts fragment
import { stripeDialect, stripeObject } from '@frontierjs/conduit-stripe'

app.conduit.receive({
  provider:   'stripe',
  path:       '/webhooks/stripe',
  dialect:    stripeDialect,
  credential: 'STRIPE_WEBHOOK_SECRET',
  async apply(ev) {
    const session = stripeObject(ev, 'checkout.session.completed')
    if (session) { await recordPayment(session.client_reference_id, session.amount_total); return 'applied' }
    return 'ignored'
  },
})
```

A body that verifies but is not an event is `ignored` with a 200, since a 401
makes Stripe retry for three days. The dedupe key is the event id, and Stripe
sends that id to every endpoint subscribed to the event, so two Receivers that
take one event each name their own `provider`.

## Connect

A connected account here is created with v1 controller properties that
behave like Standard (`FJS-D2200`): the account owner gets the full Stripe
Dashboard, Stripe collects requirements through its hosted onboarding, the
account pays Stripe's fees and Stripe carries its losses. Charges are DIRECT
charges on that account and the platform takes nothing.

```ts fragment
import { bindSend, createConnectedAccount, createAccountLink, retrieveAccountStatus, createCheckoutSession } from '@frontierjs/conduit-stripe'

const send = bindSend(app.conduit)
const { account } = await createConnectedAccount(send, { country: 'US', email, businessType: 'company', metadata: { club: club.id }, key: `club:${club.id}:account` })
const { link } = await createAccountLink(send, { account: account!.id, refreshUrl, returnUrl })   // redirect the owner to link.url

const { status } = await retrieveAccountStatus(send, account!.id)   // on return: returnUrl passes no state
if (status!.chargesEnabled) {
  const { session } = await createCheckoutSession(send, {
    account: account!.id, currency: 'usd', lineItems: [{ name: 'Spring dinner', amountMinor: 3500, quantity: 2 }],
    successUrl, cancelUrl, clientReferenceId: signup.id, paymentMethodTypes: ['card', 'us_bank_account'],
  })                                                                 // redirect the buyer to session.url
}
```

The drive's `connect.*` rows run this sequence against the sink.

- **A session that holds stock passes `expiresAt`.** Unset, Stripe keeps the page
  open 24 hours, so a buyer can pay long after the caller released the seat.
  The call refuses a time outside Stripe's 30-minute-to-24-hour window before sending.

- **Why v1 controller properties and not Accounts v2.** Accounts v2 hosted
  onboarding (`POST /v2/core/account_links`) and its requirements event
  (`v2.core.account[requirements].updated`) are shown only under a
  `.preview` API version, and v2 is a JSON API while this target is form
  encoded and pinned to `2024-06-20`. Stripe documents that a v1-created
  account can be managed later through the v2 API, and the four values are the
  same permanent responsibilities under either name, so this choice does not
  lock anything out.
- **No platform fee can be sent.** `application_fee_amount`,
  `application_fee_percent` and `transfer_data` are absent from every input
  type, and a charge that carries one by a cast is refused before sending.
- **`account` must be an `acct_…` id.** An empty string would otherwise drop
  the `Stripe-Account` header and charge the platform's own account.
- **A direct charge is refunded on its account.** `createRefund` without
  `account` answers `refused` (not found) for a connected account's intent.
- **The Connect webhook is a second endpoint.** Stripe signs connected
  accounts' events with the Connect endpoint's own secret and adds `account`.
  Register a second Receiver for it; `ev.account` names the club:

```ts fragment
app.conduit.receive({
  provider: 'stripe-connect', path: '/webhooks/stripe-connect', dialect: stripeDialect, credential: 'STRIPE_CONNECT_WEBHOOK_SECRET',
  async apply(ev) {
    const acct = stripeObject(ev, 'account.updated')
    if (acct) { await saveClubStatus(ev.account, accountStatus(acct)); return 'applied' }
    return 'ignored'
  },
})
```

## Holding a card (a deposit)

`captureMethod: 'manual'` authorizes the card and holds the amount on the
connected account. Nothing is captured until a person presses capture; an
online card's hold lasts 7 days, after which Stripe releases it itself.

```ts fragment
import { createCheckoutSession, capturePaymentIntent, cancelPaymentIntent, stripeObject } from '@frontierjs/conduit-stripe'

const { session } = await createCheckoutSession(send, {
  account: group.stripeAccount, currency: 'usd', lineItems: [{ name: 'Tent deposit', amountMinor: 8000 }],
  successUrl, clientReferenceId: loan.id, captureMethod: 'manual',
})                                                         // redirect the borrower to session.url
// on checkout.session.completed: session.payment_intent is the hold, status requires_capture
const s = stripeObject(ev, 'checkout.session.completed')!
await capturePaymentIntent(send, { id: s.payment_intent!, amountMinor: 2500, account: ev.account!, key: `loan:${loan.id}:damage` })  // the rest is released
await cancelPaymentIntent(send, { id: s.payment_intent!, account: ev.account!, key: `loan:${loan.id}:release` })                    // a good return: release it all
```

- **One capture per hold.** A partial capture releases the rest, and a second
  capture answers `refused` with `payment_intent_unexpected_state`, as does
  capturing a cancelled intent or cancelling a captured one. Capturing more
  than is held is `amount_too_large`.
- **Both keys are the caller's.** A replay after a lost response hands back
  the first capture or cancel; an unkeyed one would read as a refusal.
- **No platform fee on capture either.** Stripe's capture takes
  `application_fee_amount` and `transfer_data`; both calls refuse every
  `PLATFORM_FEE_KEYS` entry before sending.
- **A held session offers cards.** Stripe cannot hold a bank debit, so a held
  session that lists `us_bank_account` is refused.
- **The events.** Authorizing sends `charge.succeeded` (with `captured: false`
  and no balance transaction) and `payment_intent.amount_capturable_updated`;
  a held session's `checkout.session.completed` is `paid` and names the
  intent. Capture sends `charge.captured` then `payment_intent.succeeded`;
  cancel sends `payment_intent.canceled`.

## Disputes

A chargeback on a direct charge is the connected account's, so its events
reach the Connect Receiver with `ev.account`. `stripeObject` narrows each to a
`StripeDispute` (`charge`, `payment_intent`, `amount`, `reason`, `status`):

| event | when |
| --- | --- |
| `charge.dispute.created` | the cardholder disputes the charge; `status` is `needs_response` (or a `warning_*` inquiry) |
| `charge.dispute.funds_withdrawn` | the disputed amount and fee leave the account |
| `charge.dispute.updated` | evidence was submitted, usually; `under_review` |
| `charge.dispute.closed` | `won`, `lost` or `warning_closed` |
| `charge.dispute.funds_reinstated` | the money came back after a win |

```ts fragment
const du = stripeObject(ev, 'charge.dispute.created') ?? stripeObject(ev, 'charge.dispute.closed')
if (du) { await markDisputed(ev.account, du.payment_intent, du.status); return 'applied' }
```

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

| sink route | stands in for | sends |
| --- | --- | --- |
| `POST /_sink/onboard/<acct>` | the owner finishing hosted onboarding | `account.updated` |
| `POST /_sink/checkout/<cs>/complete[?method=]` | the buyer paying a session | `payment_intent.succeeded` (`.amount_capturable_updated` when held), `charge.succeeded`, `checkout.session.completed` |
| `POST /_sink/checkout/<cs>/settle` · `/fail` | the bank answering a debit | `checkout.session.async_payment_succeeded` · `_failed`, with the intent's event |
| `POST /_sink/charge/<pi>/dispute[?reason=&amount=]` | the cardholder disputing a captured charge | `charge.dispute.created`, `charge.dispute.funds_withdrawn` |
| `POST /_sink/dispute/<du>/respond` | evidence submitted | `charge.dispute.updated` (`under_review`) |
| `POST /_sink/dispute/<du>/won` · `/lost` | the bank's ruling | `charge.dispute.closed`, and `charge.dispute.funds_reinstated` after a win |

A second dispute on one charge, a dispute on an uncaptured charge, and a step
on a closed dispute answer 409.

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
