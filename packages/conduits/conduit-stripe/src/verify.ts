// src/verify.ts — is this really Stripe?
//
// Stripe signs `"<timestamp>.<raw body>"` with the endpoint secret and sends
// `Stripe-Signature: t=…,v1=…`. Three details, each of which is a real hole:
//
//   - It is over the RAW BYTES. Re-serializing the parsed object gives
//     different bytes for the same document, so every legitimate event fails.
//     `ctx.$raw.rawBody` is junction's half of this seam.
//   - A header may carry MORE THAN ONE `v1=`, which is how Stripe rotates an
//     endpoint secret without an outage. Reading the first alone refuses half
//     the events for the length of the rotation, which presents as flapping.
//   - The compare is constant-time, and the length is checked first because
//     `timingSafeEqual` throws on a mismatch, which is itself an oracle.
//
// `now` is an argument: a clock read inside a verifier is a clock a test cannot move.
//
// Connect changes the secret and not the scheme. Events on connected accounts
// go to the platform's Connect endpoint, signed with THAT endpoint's secret
// and carrying the account id as `account`; the same verifier takes that
// secret, and `account` is how the app learns whose event it is. A Connect
// endpoint is a second endpoint at Stripe with its own `whsec_…`, so it is a
// second Receiver here, at its own path, under its own provider name.

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Dialect, ReceivedEvent } from '@frontierjs/conduit'
import type { StripeEvent, StripeEventObjects } from './types.ts'

/** Stripe's own default. */
export const STRIPE_TOLERANCE_SECONDS = 300

/** `account` is the connected account the event is for, or null for an event on the platform's own account. */
export type Verified<T> = { ok: true; event: StripeEvent<T>; account: string | null } | { ok: false; reason: string }

type SignatureInput = {
  rawBody:           string
  header:            string | null | undefined
  secret:            string | undefined
  /** Seconds, from the receiver's clock. */
  now:               number
  toleranceSeconds?: number
}

export function verifyStripeSignature<T = unknown>(opts: SignatureInput): Verified<T> {
  const signed = checkSignature(opts)
  if (!signed.ok) return signed
  try {
    const event = JSON.parse(opts.rawBody) as StripeEvent<T>
    if (event?.object !== 'event' || typeof event.id !== 'string') return { ok: false, reason: 'body is not a Stripe event' }
    return { ok: true, event, account: typeof event.account === 'string' ? event.account : null }
  } catch {
    return { ok: false, reason: 'body is not JSON' }
  }
}

// The signature alone. The dialect needs it apart from the event check: a
// signed body that is not an event is a 200 there, and a 401 retries for days.
function checkSignature(opts: SignatureInput): { ok: true } | { ok: false; reason: string } {
  const { rawBody, header, secret, now, toleranceSeconds = STRIPE_TOLERANCE_SECONDS } = opts

  // `skew > NaN` is false, so a tolerance read from an unset variable would
  // verify a delivery of any age.
  if (typeof toleranceSeconds !== 'number' || !Number.isFinite(toleranceSeconds) || toleranceSeconds < 0)
    throw new TypeError('verifyStripeSignature: toleranceSeconds must be a finite number of seconds, zero or more')

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

  // Freshness before the compare, so a stale replay costs no HMAC.
  const skew = Math.abs(now - seconds)
  if (skew > toleranceSeconds) return { ok: false, reason: `timestamp is ${skew}s out, tolerance is ${toleranceSeconds}s` }

  const want = Buffer.from(createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex'), 'utf8')
  const hit  = candidates.some(got => {
    const have = Buffer.from(got, 'utf8')
    return have.length === want.length && timingSafeEqual(have, want)
  })
  if (!hit) return { ok: false, reason: 'signature does not match' }
  return { ok: true }
}

// ─── The Dialect for `app.conduit.receive()` (FJS-D899) ──────────────────────

/** A received Stripe event; `payload` is the whole event, as Stripe sent it, and `account` the connected account it is for (null on the platform's own). */
export type StripeReceivedEvent = ReceivedEvent & { payload: StripeEvent; account: string | null }

const isEvent = (b: unknown): b is StripeEvent =>
  !!b && typeof b === 'object' && (b as StripeEvent).object === 'event'
  && typeof (b as StripeEvent).id === 'string' && typeof (b as StripeEvent).type === 'string'

/**
 * Stripe's half of a Receiver. The credential is the endpoint's `whsec_…`
 * secret. The dedupe key is the event id, which Stripe keeps across retries
 * and also sends to every endpoint subscribed to the event. Receipts are keyed
 * by `provider` and this id, so two Receivers that each take the same event
 * name two providers, or the second one answers `duplicate` and never applies.
 */
export const stripeDialect: Dialect<string, StripeReceivedEvent> = {
  verify(d, secret, { now }) {
    return checkSignature({ rawBody: d.rawBody, header: d.headers['stripe-signature'], secret, now })
  },
  parse: d => isEvent(d.body) ? { id: d.body.id, type: d.body.type, payload: d.body, account: typeof d.body.account === 'string' ? d.body.account : null } : null,
  dedupeKey: (_d, ev) => ev.id,
}

/**
 * The event's object, typed, when the event is `type` — else `null`. An `apply`
 * narrows with it instead of casting `data.object` by hand:
 * `const s = stripeObject(ev, 'checkout.session.completed'); if (s) …`
 */
export function stripeObject<K extends keyof StripeEventObjects>(ev: { type: string; payload: StripeEvent }, type: K): StripeEventObjects[K] | null {
  return ev.type === type ? ev.payload.data.object as StripeEventObjects[K] : null
}
