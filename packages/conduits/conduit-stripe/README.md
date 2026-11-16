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
| calls | `createPaymentIntent(send, …)` (replayable, unkeyed unless asked), `createRefund(send, …)` (key required), `createCheckoutSession(send, …)` (replayable, unkeyed unless asked) — each takes `account` for a direct charge |
| connect | `createConnectedAccount` (key required), `createAccountLink`, `retrieveAccountStatus`, `accountStatus(account)`, `STANDARD_LIKE_CONTROLLER`, `PLATFORM_FEE_KEYS` — below |
| payload types | `PaymentIntent`, `StripeRefund`, `StripeCharge`, `StripeEvent`, `StripeCheckoutSession`, `StripeInvoice`, `StripeAccount`, `StripeAccountLink`, `StripeAccountStatus`, `StripeErrorBody` |
| error mapping | `translate(ConduitError) → StripeFailure` — the table below |
| verifier | `verifyStripeSignature({ rawBody, header, secret, now })` — pure; `{ ok, event, account }` |
| dialect | `stripeDialect` for `app.conduit.receive()`; `ev.account` names the connected account; `stripeObject(ev, 'invoice.paid')` narrows the event's object by type |
| sink | `sink.ts`, `startStripeSink()` on `port: 0` |
| tax | `tax` namespace (`src/tax.ts`) — Stripe Tax, below |
| drive | `bun run drive` — 37 rows (19 stripe, 8 `connect.*`, 10 `tax.*`), sink only; no conforming Stripe exists |

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
