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
import type { PaymentIntent, StripeRefund } from './types.ts'

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
  key?:        string
}): Promise<{ intent?: PaymentIntent; error?: StripeFailure }> {
  assertMinor(req.amountMinor, 'amountMinor')
  const result = await send<PaymentIntent>({
    method: 'POST',
    path:   '/v1/payment_intents',
    body:   {
      amount:   req.amountMinor,
      currency: req.currency.toLowerCase(),
      automatic_payment_methods: { enabled: true },
      metadata: { order_reference: req.reference },
    },
    ...(req.key ? { idempotency_key: req.key } : { replayable: true }),
  })
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
    idempotency_key: req.key,
  })
  if (result.error) return { error: translate(result.error) }
  return { refund: result.data }
}
