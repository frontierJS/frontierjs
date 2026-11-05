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

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { StripeEvent } from './types.ts'

/** Stripe's own default. */
export const STRIPE_TOLERANCE_SECONDS = 300

export type Verified<T> = { ok: true; event: StripeEvent<T> } | { ok: false; reason: string }

export function verifyStripeSignature<T = unknown>(opts: {
  rawBody:           string
  header:            string | null | undefined
  secret:            string | undefined
  /** Seconds, from the receiver's clock. */
  now:               number
  toleranceSeconds?: number
}): Verified<T> {
  const { rawBody, header, secret, now, toleranceSeconds = STRIPE_TOLERANCE_SECONDS } = opts

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

  try {
    const event = JSON.parse(rawBody) as StripeEvent<T>
    if (event?.object !== 'event' || typeof event.id !== 'string') return { ok: false, reason: 'body is not a Stripe event' }
    return { ok: true, event }
  } catch {
    return { ok: false, reason: 'body is not JSON' }
  }
}
