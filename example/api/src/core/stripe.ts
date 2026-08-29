// api/src/core/stripe.ts — the Stripe connection, both directions.
//
// The sibling of `psp.ts` and deliberately beside it rather than instead of it.
// `psp.ts` is a target speaking THIS project's own conventions — JSON bodies,
// `X-Psp` HMAC headers, a shape conduit was designed alongside. Stripe is a real
// vendor: form-encoded requests, a bearer key, a pinned API version, and a
// webhook signature scheme of its own. Having both against one boundary is the
// only thing that shows whether the boundary is generic, which no single
// connector can (`FJS-D153`).
//
// It is here and not in `@frontierjs/conduit-stripe` on purpose, and the ruling
// says why: one instance cannot design the connector interface. It moves when a
// second connector exists to argue with it.
//
// ─── Two secrets, same reason as psp.ts ───────────────────────────────────
//
// `STRIPE_SECRET_KEY` is what the shop spends with. `STRIPE_WEBHOOK_SECRET` is
// what Stripe signs events with. They are separate at Stripe and separate here:
// one compromise must not be both directions.

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { App }                    from '@frontierjs/junction'
import type { TargetDescriptor }       from '@frontierjs/conduit'

export const STRIPE_TARGET = 'provider:stripe'

/** Where Stripe is. `api/src/core/stripe-sink.ts` unless pointed at the real one. */
export const STRIPE_URL = process.env.STRIPE_URL
  ?? `http://localhost:${process.env.STRIPE_SINK_PORT ?? 8114}`

/**
 * The API version this connector is written against.
 *
 * Pinned, and it has to be: without the header Stripe uses the ACCOUNT's default
 * version, which somebody can change in a dashboard — so the shape of every
 * response would move for reasons that are not in this repository, and the
 * change would arrive in production rather than in a diff.
 */
export const STRIPE_API_VERSION = '2024-06-20'

/** The path Stripe POSTs events to. One constant, three readers. */
export const STRIPE_WEBHOOK_PATH = '/webhooks/stripe'

/** Stripe's own clock tolerance for a webhook, in seconds. Their default. */
const TOLERANCE_SECONDS = 300

/**
 * The declared target.
 *
 * `encoding: 'form'` is the whole reason conduit grew one (`FJS-556`): Stripe's
 * API is `application/x-www-form-urlencoded`, and until conduit could say so
 * every body went out as JSON with the content-type free to disagree — a request
 * that looked configured and was not.
 *
 * `bearer` rather than `hmac`, because that is what Stripe issues. The ref is
 * resolved at send time and never stored on the descriptor.
 */
export function stripeTarget(): TargetDescriptor {
  return {
    id:            STRIPE_TARGET,
    kind:          'provider',
    protocol:      'http',
    address:       STRIPE_URL,
    encoding:      'form',
    auth:          { type: 'bearer', ref: 'STRIPE_SECRET_KEY' },
    registered_at: Date.now(),
    last_seen_at:  null,
  }
}

// ─── What comes back ──────────────────────────────────────────────────────

export interface PaymentIntent {
  id:       string
  object:   'payment_intent'
  amount:   number      // minor units
  currency: string
  status:   string      // requires_payment_method | succeeded | …
  client_secret?: string
  metadata?: Record<string, string>
}

export interface StripeRefund {
  id:             string
  object:         'refund'
  amount:         number
  currency:       string
  payment_intent: string
  status:         string
}

/** A failure, in the shop's terms rather than the transport's. */
export interface StripeFailure {
  kind:      string
  message:   string
  retryable: boolean
  /** Stripe's own machine-readable code, where it gave one — `card_declined`. */
  code?:     string
  /** Stripe's category — `card_error`, `invalid_request_error`, `api_error`. */
  type?:     string
}

/**
 * Conduit's error → the shop's.
 *
 * Conduit classifies by STATUS, which is right for a transport and wrong for a
 * payment: a card decline is HTTP 402 and arrives as `server_error` with
 * `retryable: false`, which is true of neither half of the name. Stripe puts the
 * real answer in the body, and conduit keeps that body on `error.raw` — so this
 * is a translation and not a guess.
 *
 * A declined card is NOT retryable and must not be presented as a provider
 * outage; an `api_error` is Stripe having a bad minute and is.
 */
function translate(error: { kind: string; message: string; retryable?: boolean; raw?: unknown }): StripeFailure {
  const base: StripeFailure = {
    kind:      error.kind,
    message:   error.message,
    retryable: error.retryable ?? false,
  }

  let body: { error?: { type?: string; code?: string; message?: string } } | null = null
  try {
    body = typeof error.raw === 'string' ? JSON.parse(error.raw) : (error.raw as typeof body)
  } catch { /* not JSON — keep the transport's own sentence */ }

  const e = body?.error
  if (!e) return base

  return {
    kind:      e.type === 'card_error' ? 'declined' : base.kind,
    message:   e.message ?? base.message,
    // Stripe's own advice: only api_error and rate limits are worth trying again.
    retryable: e.type === 'api_error' ? true : base.retryable,
    ...(e.code ? { code: e.code } : {}),
    ...(e.type ? { type: e.type } : {}),
  }
}

function requireConduit(app: App) {
  const conduit = app.conduit
  if (!conduit) throw new Error('stripe: app.conduit is not configured')
  return conduit
}

/** Every call carries the pinned version. */
const VERSION_HEADER = { 'Stripe-Version': STRIPE_API_VERSION }

/**
 * Create a PaymentIntent.
 *
 * `amountMinor` is an INTEGER in the currency's minor units and this function
 * will not take anything else — Stripe's wire format has no decimal point, and
 * a shop that hands `12.40` here sends twelve pence. The conversion belongs
 * where the currency is known, which is the caller; `@frontierjs/toolbelt/units`
 * is what knows that JPY has no minor unit and USD has two.
 *
 * `automatic_payment_methods[enabled]` is the demonstration worth keeping: a
 * nested key, which is exactly what form encoding is for and what a JSON body
 * could never have expressed to this API.
 */
export async function createPaymentIntent(app: App, req: {
  amountMinor: number
  currency:    string
  reference:   string
  /** Optional. A retried create makes a second intent without one. */
  key?:        string
}): Promise<{ intent?: PaymentIntent; error?: StripeFailure }> {
  if (!Number.isInteger(req.amountMinor)) {
    throw new TypeError(
      `stripe: amountMinor must be an integer in minor units, got ${req.amountMinor}. ` +
      `A major-unit amount here charges a hundredth of what was meant.`
    )
  }

  const result = await requireConduit(app).send<PaymentIntent>({
    target:  STRIPE_TARGET,
    method:  'POST',
    path:    '/v1/payment_intents',
    headers: VERSION_HEADER,
    body:    {
      amount:   req.amountMinor,
      currency: req.currency.toLowerCase(),
      automatic_payment_methods: { enabled: true },
      metadata: { order_reference: req.reference },
    },
    ...(req.key ? { idempotency_key: req.key } : {}),
  })

  if (result.error) return { error: translate(result.error) }
  return { intent: result.data }
}

/**
 * Refund a PaymentIntent, in whole or in part.
 *
 * The one outbound call in this app where a retry costs real money, so the key
 * is REQUIRED rather than optional — conduit puts it on the wire as
 * `Idempotency-Key`, which is the header Stripe honours under that exact name.
 * It is the caller's to choose: what makes two attempts "the same refund" is a
 * question about the shop's intention, and a uuid minted here would be unique
 * and would guard nothing.
 *
 * Omitting `amountMinor` refunds the remainder, which is what a shop means nine
 * times in ten. Stating a number to mean "everything" is what goes wrong when
 * the number is stale.
 */
export async function createRefund(app: App, req: {
  paymentIntentId: string
  amountMinor?:    number
  key:             string
}): Promise<{ refund?: StripeRefund; error?: StripeFailure }> {
  if (req.amountMinor !== undefined && !Number.isInteger(req.amountMinor)) {
    throw new TypeError(`stripe: amountMinor must be an integer in minor units, got ${req.amountMinor}`)
  }

  const result = await requireConduit(app).send<StripeRefund>({
    target:  STRIPE_TARGET,
    method:  'POST',
    path:    '/v1/refunds',
    headers: VERSION_HEADER,
    body:    {
      payment_intent: req.paymentIntentId,
      ...(req.amountMinor === undefined ? {} : { amount: req.amountMinor }),
    },
    idempotency_key: req.key,
  })

  if (result.error) return { error: translate(result.error) }
  return { refund: result.data }
}

// ─── Inbound: is this really Stripe? ──────────────────────────────────────

/**
 * Verify a `Stripe-Signature` header.
 *
 * Stripe's scheme, not this project's, and that is the point of having it here:
 * `@frontierjs/toolbelt/signature` is the one definition of what a signed
 * request looks like *between FrontierJS processes* — a canonical string over
 * method, path, timestamp, nonce and a body hash. Stripe signs
 * `"<timestamp>.<raw body>"` and nothing else. Same primitive, different
 * language; a connector owns its vendor's dialect (`FJS-D153`).
 *
 * Three details that are easy to get wrong and each of which is a real hole:
 *
 *   - It is over the RAW BYTES. Re-serialising the parsed object gives
 *     different bytes for the same document — key order, whitespace, number
 *     formatting — so the signature would fail for every legitimate event.
 *     `ctx.$raw.rawBody` is junction's half of this seam.
 *   - A header may carry MORE THAN ONE `v1=`, which is how Stripe rotates an
 *     endpoint secret without an outage. Reading only the first refuses half
 *     the events during a rotation, which presents as flapping.
 *   - The compare is constant-time. A byte-at-a-time compare leaks the expected
 *     signature to anyone willing to make enough attempts.
 *
 * Answers `{ ok }` or `{ ok: false, reason }`. The reason is for the log and
 * never for the response: a forger learns that it failed, whoever is on call
 * learns that Stripe's clock is 40 seconds out.
 */
export function verifyStripeSignature(opts: {
  rawBody:   string
  header:    string | null | undefined
  secret:    string | undefined
  /** Seconds, from the receiver's clock. Required, for `verifyRequest`'s reason:
   *  a default here is a clock read in a place that should not have one. */
  now:       number
  toleranceSeconds?: number
}): { ok: true } | { ok: false; reason: string } {
  const { rawBody, header, secret, now, toleranceSeconds = TOLERANCE_SECONDS } = opts

  if (!secret) return { ok: false, reason: 'no webhook secret is configured on this side' }
  if (!header) return { ok: false, reason: 'no Stripe-Signature header' }

  let timestamp: string | null = null
  const candidates: string[] = []
  for (const part of header.split(',')) {
    const [k, v] = part.trim().split('=', 2)
    if (k === 't' && v) timestamp = v
    if (k === 'v1' && v) candidates.push(v)
  }

  if (!timestamp || !candidates.length) return { ok: false, reason: 'signature header is malformed' }

  const seconds = Number(timestamp)
  if (!Number.isFinite(seconds)) return { ok: false, reason: 'timestamp is not a number' }

  // The freshness check runs BEFORE the compare, so a stale replay costs no
  // HMAC — and it is the same order psp.ts uses for the same reason.
  const skew = Math.abs(now - seconds)
  if (skew > toleranceSeconds)
    return { ok: false, reason: `timestamp is ${skew}s out, tolerance is ${toleranceSeconds}s` }

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')
  const want     = Buffer.from(expected, 'utf8')

  for (const got of candidates) {
    const have = Buffer.from(got, 'utf8')
    // timingSafeEqual throws on a length mismatch, which is itself an oracle if
    // it escapes — so the length is checked first and a wrong length is simply
    // not a match.
    if (have.length === want.length && timingSafeEqual(have, want)) return { ok: true }
  }

  return { ok: false, reason: 'signature does not match' }
}
