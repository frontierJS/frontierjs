// @frontierjs/conduit-stripe — Stripe over conduit, both directions.
//
// Extracted from `example/api/src/providers/stripe/` (FJS-D153's first
// instance). The builder returns a descriptor and installs nothing (FJS-D890);
// every call takes `send` rather than an app, so the connector runs in a drive
// with no junction in the process.
//
// ─── Two secrets, one per direction ──────────────────────────────────────
// `STRIPE_SECRET_KEY` is what the shop spends with; `STRIPE_WEBHOOK_SECRET`
// is what Stripe signs events with. Separate at Stripe, separate here: one
// compromise must not be both directions.

import type { ConduitRequest, ConduitResult, TargetDescriptor } from '@frontierjs/conduit'
import { translate, type StripeFailure } from './errors.ts'
import type { PaymentIntent, StripeRefund, StripeAccount, StripeAccountLink, StripeAccountStatus, StripeCheckoutSession, StripeBalanceTransaction } from './types.ts'

export * from './types.ts'
export * from './errors.ts'
export * from './verify.ts'
export * as tax from './tax.ts'

export const STRIPE_TARGET      = 'provider:stripe'
export const STRIPE_ADDRESS     = 'https://api.stripe.com'

/**
 * Pinned, and it has to be: without the header Stripe uses the ACCOUNT's
 * default version, which somebody can change in a dashboard, so the shape of
 * every response would move for reasons that are not in this repository.
 */
export const STRIPE_API_VERSION = '2024-06-20'

/** The send half, bound to the target. `(req) => conduit.send({ target: STRIPE_TARGET, ...req })`. */
export type Send = <T>(req: Omit<ConduitRequest, 'target'>) => Promise<ConduitResult<T>>

export function bindSend(conduit: { send<T>(req: ConduitRequest): Promise<ConduitResult<T>> }, target = STRIPE_TARGET): Send {
  return req => conduit.send({ target, ...req })
}

/**
 * The declared target.
 *
 * `encoding: 'form'` is the whole reason conduit grew one (FJS-556): Stripe
 * is `application/x-www-form-urlencoded`. The version header and the
 * idempotency header name are facts about who is on the other end, so they
 * sit on the target and never per call.
 */
export function stripeTarget(opts: { ref?: string; address?: string; id?: string } = {}): TargetDescriptor {
  return {
    id:            opts.id ?? STRIPE_TARGET,
    kind:          'provider',
    protocol:      'http',
    address:       opts.address ?? STRIPE_ADDRESS,
    encoding:      'form',
    auth:          { type: 'bearer', ref: opts.ref ?? 'STRIPE_SECRET_KEY' },
    headers:       { 'Stripe-Version': STRIPE_API_VERSION },
    idempotency:   { header: 'Idempotency-Key' },
    registered_at: Date.now(),
    last_seen_at:  null,
  }
}

// ─── Connect: whose account the money lands in (FJS-D2200) ───────────────
//
// A club's ticket and dues money is the club's: charges are DIRECT charges on
// its own connected account and the platform takes nothing. These keys are
// how a platform takes a cut or moves the money elsewhere, so no input type
// here offers them and the runtime refuses them too — a cast or a spread
// carries a key the type never offered.

/** Keys no charge this connector builds may carry. */
export const PLATFORM_FEE_KEYS = ['application_fee_amount', 'application_fee_percent', 'transfer_data'] as const

function refusePlatformFee(where: string, ...objects: unknown[]): void {
  for (const o of objects)
    if (o && typeof o === 'object')
      for (const k of PLATFORM_FEE_KEYS)
        if (k in o) throw new TypeError(`stripe: ${where} refuses '${k}' — a connected account's charge carries no platform fee (FJS-D2200)`)
}

// An empty or mistyped id must not fall through to a charge on the PLATFORM's
// own account, which is what an absent `Stripe-Account` header means.
function assertAccountId(account: string, what = 'account'): void {
  if (typeof account !== 'string' || !/^acct_[A-Za-z0-9]+$/.test(account))
    throw new TypeError(`stripe: ${what} must be a connected account id (acct_…), got ${JSON.stringify(account)}`)
}

function onAccount(account: string | undefined): { headers?: Record<string, string> } {
  if (account === undefined) return {}
  assertAccountId(account)
  return { headers: { 'Stripe-Account': account } }
}

function assertMinor(n: number | undefined, what: string): void {
  if (n !== undefined && !Number.isInteger(n))
    throw new TypeError(`stripe: ${what} must be an integer in minor units, got ${n}. A major-unit amount here charges a hundredth of what was meant.`)
}

/**
 * Create a PaymentIntent. `amountMinor` is an INTEGER in the currency's minor
 * units: Stripe's wire format has no decimal point, and `12.40` here sends
 * twelve pence. `@frontierjs/toolbelt/units` is what knows the exponent.
 *
 * `replayable: true` and no key, on purpose: minting an intent moves no money,
 * and after a decline the next attempt must be a NEW intent rather than the
 * refused one handed back under the same key.
 */
export async function createPaymentIntent(send: Send, req: {
  amountMinor: number
  currency:    string
  reference:   string
  /** A connected account id: the intent is a DIRECT charge on it, sent as `Stripe-Account`. */
  account?:    string
  key?:        string
}): Promise<{ intent?: PaymentIntent; error?: StripeFailure }> {
  assertMinor(req.amountMinor, 'amountMinor')
  refusePlatformFee('createPaymentIntent', req)
  const body = {
    amount:   req.amountMinor,
    currency: req.currency.toLowerCase(),
    automatic_payment_methods: { enabled: true },
    metadata: { order_reference: req.reference },
  }
  refusePlatformFee('createPaymentIntent', body)
  const result = await send<PaymentIntent>({
    method: 'POST',
    path:   '/v1/payment_intents',
    body,
    ...onAccount(req.account),
    ...(req.key ? { idempotency_key: req.key } : { replayable: true }),
  })
  if (result.error) return { error: translate(result.error) }
  return { intent: result.data }
}

/**
 * Read one PaymentIntent back. A second press of Pay finds the pending
 * payment row, and the browser needs that intent's `client_secret` again, which
 * the app never stored. A direct charge's intent lives on the connected
 * account, so `account` is required to find it there; without it the read
 * looks on the platform and answers not found.
 */
export async function retrievePaymentIntent(send: Send, req: {
  id:       string
  account?: string
}): Promise<{ intent?: PaymentIntent; error?: StripeFailure }> {
  // The id is a path segment: a stored provider reference is caller data and must not walk to another resource.
  if (typeof req.id !== 'string' || !/^pi_[A-Za-z0-9_]+$/.test(req.id))
    throw new TypeError(`stripe: a payment intent id is pi_…, got ${JSON.stringify(req.id)}`)
  const result = await send<PaymentIntent>({ method: 'GET', path: `/v1/payment_intents/${req.id}`, ...onAccount(req.account) })
  if (result.error) return { error: translate(result.error) }
  return { intent: result.data }
}

/**
 * Refund, in whole or in part. The one call where a retry costs real money,
 * so the key is REQUIRED: what makes two attempts the same refund is the
 * shop's intention, and a uuid minted here would be unique and guard nothing.
 */
export async function createRefund(send: Send, req: {
  paymentIntentId: string
  amountMinor?:    number
  /** The connected account the charge was made on; a direct charge is refunded there or not found. */
  account?:        string
  key:             string
}): Promise<{ refund?: StripeRefund; error?: StripeFailure }> {
  assertMinor(req.amountMinor, 'amountMinor')
  if (!req.key) throw new TypeError('stripe: a refund needs an idempotency key')
  const result = await send<StripeRefund>({
    method: 'POST',
    path:   '/v1/refunds',
    body:   {
      payment_intent: req.paymentIntentId,
      ...(req.amountMinor === undefined ? {} : { amount: req.amountMinor }),
    },
    ...onAccount(req.account),
    idempotency_key: req.key,
  })
  if (result.error) return { error: translate(result.error) }
  return { refund: result.data }
}

/**
 * The controller values that make a v1 account behave like Standard
 * (FJS-D2200): Stripe is liable for losses, the account pays Stripe's fees,
 * Stripe collects requirements through its hosted onboarding, and the club
 * has the full Dashboard. All four are permanent on the account, so they are
 * a constant and never an argument.
 * https://docs.stripe.com/connect/migrate-to-controller-properties
 */
export const STANDARD_LIKE_CONTROLLER = Object.freeze({
  losses:                 { payments: 'stripe' },
  fees:                   { payer: 'account' },
  requirement_collection: 'stripe',
  stripe_dashboard:       { type: 'full' },
} as const)

/**
 * Create a connected account for a club. The key is REQUIRED: an unkeyed
 * retry after a lost response is a second account, and the club onboards the
 * one the app did not keep.
 */
export async function createConnectedAccount(send: Send, req: {
  /** ISO 3166-1 alpha-2. */
  country:       string
  email?:        string
  /** A hint; once an account link exists only the owner can change it, in onboarding. */
  businessType?: 'company' | 'individual' | 'non_profit' | 'government_entity'
  metadata?:     Record<string, string>
  key:           string
}): Promise<{ account?: StripeAccount; error?: StripeFailure }> {
  if (!req.key) throw new TypeError('stripe: creating a connected account needs an idempotency key')
  const result = await send<StripeAccount>({
    method: 'POST',
    path:   '/v1/accounts',
    body:   {
      country:    req.country.toUpperCase(),
      controller: STANDARD_LIKE_CONTROLLER,
      ...(req.email        ? { email: req.email } : {}),
      ...(req.businessType ? { business_type: req.businessType } : {}),
      ...(req.metadata     ? { metadata: req.metadata } : {}),
    },
    idempotency_key: req.key,
  })
  if (result.error) return { error: translate(result.error) }
  return { account: result.data }
}

/**
 * A single-use link into Stripe's hosted onboarding. `refreshUrl` is where a
 * spent or expired link lands, and it should mint a new link; `returnUrl`
 * passes no state and does NOT mean onboarding finished — read the status.
 * Unkeyed and replayable, as an intent is: a link moves no money.
 */
export async function createAccountLink(send: Send, req: {
  account:    string
  refreshUrl: string
  returnUrl:  string
  key?:       string
}): Promise<{ link?: StripeAccountLink; error?: StripeFailure }> {
  assertAccountId(req.account)
  const result = await send<StripeAccountLink>({
    method: 'POST',
    path:   '/v1/account_links',
    body:   { account: req.account, type: 'account_onboarding', refresh_url: req.refreshUrl, return_url: req.returnUrl },
    ...(req.key ? { idempotency_key: req.key } : { replayable: true }),
  })
  if (result.error) return { error: translate(result.error) }
  return { link: result.data }
}

/** The status read off an account object — the retrieved one, or the one `account.updated` carries. */
export function accountStatus(account: StripeAccount): StripeAccountStatus {
  const r = account.requirements
  return {
    id:               account.id,
    chargesEnabled:   !!account.charges_enabled,
    payoutsEnabled:   !!account.payouts_enabled,
    detailsSubmitted: !!account.details_submitted,
    currentlyDue:     r?.currently_due ?? [],
    pastDue:          r?.past_due ?? [],
    eventuallyDue:    r?.eventually_due ?? [],
    disabledReason:   r?.disabled_reason ?? null,
  }
}

export async function retrieveAccountStatus(send: Send, account: string): Promise<{ status?: StripeAccountStatus; error?: StripeFailure }> {
  assertAccountId(account)
  const result = await send<StripeAccount>({ method: 'GET', path: `/v1/accounts/${account}` })
  if (result.error) return { error: translate(result.error) }
  return { status: accountStatus(result.data!) }
}

/**
 * The balance transaction a charge names in `balance_transaction` — its `fee`
 * is Stripe's fee on the charge. A direct charge's lives on the connected
 * account, so `account` is required to find it there; without it the read
 * looks on the platform and answers not found.
 */
export async function retrieveBalanceTransaction(send: Send, req: {
  id:       string
  account?: string
}): Promise<{ balanceTransaction?: StripeBalanceTransaction; error?: StripeFailure }> {
  // The id is a path segment: a webhook's `balance_transaction` is caller data and must not walk to another resource.
  if (typeof req.id !== 'string' || !/^txn_[A-Za-z0-9]+$/.test(req.id))
    throw new TypeError(`stripe: a balance transaction id is txn_…, got ${JSON.stringify(req.id)}`)
  const result = await send<StripeBalanceTransaction>({ method: 'GET', path: `/v1/balance_transactions/${req.id}`, ...onAccount(req.account) })
  if (result.error) return { error: translate(result.error) }
  return { balanceTransaction: result.data }
}

/** One line on a hosted Checkout page, priced inline. */
export interface CheckoutLineItem {
  name:        string
  amountMinor: number
  quantity?:   number
}

/**
 * A hosted Checkout page in `payment` mode — on a connected account when
 * `account` is given, as a direct charge. `paymentMethodTypes` is how ACH is
 * offered (`['card', 'us_bank_account']`); absent, Stripe offers what the
 * account has turned on. `metadata` is copied onto the PaymentIntent as well,
 * so `payment_intent.succeeded` and a later refund carry it.
 * Unkeyed and replayable: a session moves no money until somebody pays it.
 */
export async function createCheckoutSession(send: Send, req: {
  currency:            string
  lineItems:           CheckoutLineItem[]
  successUrl:          string
  cancelUrl?:          string
  account?:            string
  clientReferenceId?:  string
  customerEmail?:      string
  metadata?:           Record<string, string>
  paymentMethodTypes?: string[]
  /** When the hosted page stops taking payment. Stripe allows 30 minutes to 24 hours from now, and 24 hours when unset. */
  expiresAt?:          Date
  key?:                string
}): Promise<{ session?: StripeCheckoutSession; error?: StripeFailure }> {
  if (!req.lineItems?.length) throw new TypeError('stripe: a checkout session needs at least one line item')
  for (const li of req.lineItems) assertMinor(li.amountMinor, `lineItems[${li.name}].amountMinor`)
  refusePlatformFee('createCheckoutSession', req)
  // Stripe answers a bare 400 for a window outside its bounds, and a caller holding
  // stock against this moment needs to know before the buyer is sent away.
  const life = req.expiresAt ? req.expiresAt.getTime() - Date.now() : null
  if (life !== null && !(life >= 30 * 60_000 && life <= 24 * 3_600_000))
    throw new TypeError('stripe: a checkout session expires between 30 minutes and 24 hours from now')
  const currency = req.currency.toLowerCase()
  const body = {
    mode:        'payment',
    line_items:  req.lineItems.map(li => ({ price_data: { currency, unit_amount: li.amountMinor, product_data: { name: li.name } }, quantity: li.quantity ?? 1 })),
    success_url: req.successUrl,
    ...(req.cancelUrl          ? { cancel_url: req.cancelUrl } : {}),
    ...(req.clientReferenceId  ? { client_reference_id: req.clientReferenceId } : {}),
    ...(req.customerEmail      ? { customer_email: req.customerEmail } : {}),
    ...(req.paymentMethodTypes ? { payment_method_types: req.paymentMethodTypes } : {}),
    ...(req.expiresAt          ? { expires_at: Math.floor(req.expiresAt.getTime() / 1000) } : {}),
    ...(req.metadata           ? { metadata: req.metadata, payment_intent_data: { metadata: req.metadata } } : {}),
  }
  refusePlatformFee('createCheckoutSession', body, (body as { payment_intent_data?: object }).payment_intent_data)
  const result = await send<StripeCheckoutSession>({
    method: 'POST',
    path:   '/v1/checkout/sessions',
    body,
    ...onAccount(req.account),
    ...(req.key ? { idempotency_key: req.key } : { replayable: true }),
  })
  if (result.error) return { error: translate(result.error) }
  return { session: result.data }
}
