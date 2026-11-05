// src/verify.ts — is this really Slack?
//
// Slack signs `"v0:<X-Slack-Request-Timestamp>:<raw body>"` with the app's
// signing secret and sends `X-Slack-Signature: v0=<hex>`. The details that are
// each a hole: the HMAC is over the RAW bytes (a re-serialized body is a
// different document); the timestamp is graded before any crypto so a stale
// replay costs no HMAC; the compare is constant-time with the length checked
// first, because `timingSafeEqual` throws on a length mismatch, which is
// itself an oracle. `now` is an argument: a clock read inside a verifier is a
// clock a test cannot move.
//
// Slack redelivers an event the app did not answer 200 within three seconds,
// up to three times, under `X-Slack-Retry-Num`. The verifier accepts the
// redelivery like any other — it is signed — and `retryOf` is how the app
// knows to answer 200 without processing twice. The dedupe table is the app's.

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { SlackEvent, SlackEventEnvelope, UrlVerification } from './types.ts'

/** Slack's own recommendation. */
export const SLACK_TOLERANCE_SECONDS = 300

export type HeaderBag = Record<string, string | null | undefined> | { get(name: string): string | null }

const read = (headers: HeaderBag, name: string): string | null => {
  if (typeof (headers as { get?: unknown }).get === 'function') return (headers as { get(n: string): string | null }).get(name)
  const bag = headers as Record<string, string | null | undefined>
  return bag[name] ?? bag[name.toLowerCase()] ?? null
}

export type Verified<T> =
  | { ok: true; event: SlackEventEnvelope<T>; challenge?: undefined }
  | { ok: true; event: UrlVerification; challenge: string }
  | { ok: false; reason: string }

export function verifySlackSignature<T = unknown>(opts: {
  rawBody:           string
  headers:           HeaderBag
  secret:            string | undefined
  /** Seconds, from the receiver's clock. */
  now:               number
  toleranceSeconds?: number
}): Verified<T> {
  const { rawBody, headers, secret, now, toleranceSeconds = SLACK_TOLERANCE_SECONDS } = opts
  if (!secret) return { ok: false, reason: 'no signing secret is configured on this side' }

  const signature = read(headers, 'x-slack-signature')
  const timestamp = read(headers, 'x-slack-request-timestamp')
  if (!signature) return { ok: false, reason: 'no X-Slack-Signature header' }
  if (!timestamp) return { ok: false, reason: 'no X-Slack-Request-Timestamp header' }

  const seconds = Number(timestamp)
  if (!Number.isFinite(seconds)) return { ok: false, reason: 'timestamp is not a number' }
  const skew = Math.abs(now - seconds)
  if (skew > toleranceSeconds) return { ok: false, reason: `timestamp is ${skew}s out, tolerance is ${toleranceSeconds}s` }

  if (!signature.startsWith('v0=')) return { ok: false, reason: 'signature is not version v0' }
  const want = Buffer.from(createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex'), 'utf8')
  const have = Buffer.from(signature.slice(3), 'utf8')
  if (have.length !== want.length || !timingSafeEqual(have, want)) return { ok: false, reason: 'signature does not match' }

  let event: SlackEvent<T>
  try { event = JSON.parse(rawBody) as SlackEvent<T> } catch { return { ok: false, reason: 'body is not JSON' } }
  if (!event || typeof event !== 'object') return { ok: false, reason: 'body is not a Slack event' }
  if (event.type === 'url_verification') {
    if (typeof event.challenge !== 'string') return { ok: false, reason: 'url_verification without a challenge' }
    return { ok: true, event, challenge: event.challenge }
  }
  if (event.type !== 'event_callback' || typeof event.event_id !== 'string') return { ok: false, reason: 'body is not a Slack event' }
  return { ok: true, event }
}

/** The redelivery headers, where this is one; `null` for a first delivery. */
export function retryOf(headers: HeaderBag): { num: number; reason: string | null } | null {
  const raw = read(headers, 'x-slack-retry-num')
  if (raw === null) return null
  const num = Number(raw)
  if (!Number.isInteger(num) || num < 1) return null
  return { num, reason: read(headers, 'x-slack-retry-reason') }
}
