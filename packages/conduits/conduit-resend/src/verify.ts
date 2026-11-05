// src/verify.ts — is this really Resend?
//
// Resend's webhooks are Svix-signed: `svix-id`, `svix-timestamp` and
// `svix-signature` (`v1,<base64>` pairs, space-separated — more than one
// while a secret rotates). The signed content is `"<id>.<timestamp>.<raw>"`
// and the secret is `whsec_` followed by base64 key bytes. Over the raw bytes,
// every candidate tried, constant-time, `now` an argument.

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { ResendEvent } from './types.ts'

export const RESEND_TOLERANCE_SECONDS = 300

export type Verified = { ok: true; event: ResendEvent } | { ok: false; reason: string }

export function verifyResendSignature(opts: {
  rawBody:           string
  headers:           { 'svix-id'?: string | null; 'svix-timestamp'?: string | null; 'svix-signature'?: string | null }
  secret:            string | undefined
  now:               number
  toleranceSeconds?: number
}): Verified {
  const { rawBody, headers, secret, now, toleranceSeconds = RESEND_TOLERANCE_SECONDS } = opts
  if (!secret) return { ok: false, reason: 'no webhook secret is configured on this side' }
  const id = headers['svix-id'], ts = headers['svix-timestamp'], sigs = headers['svix-signature']
  if (!id || !ts || !sigs) return { ok: false, reason: 'svix headers are missing' }

  const seconds = Number(ts)
  if (!Number.isFinite(seconds)) return { ok: false, reason: 'timestamp is not a number' }
  const skew = Math.abs(now - seconds)
  if (skew > toleranceSeconds) return { ok: false, reason: `timestamp is ${skew}s out, tolerance is ${toleranceSeconds}s` }

  const key  = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  const want = Buffer.from(createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest('base64'), 'utf8')
  const hit  = sigs.split(' ').some(part => {
    const [version, value] = part.split(',', 2)
    if (version !== 'v1' || !value) return false
    const have = Buffer.from(value, 'utf8')
    return have.length === want.length && timingSafeEqual(have, want)
  })
  if (!hit) return { ok: false, reason: 'signature does not match' }
  try {
    const event = JSON.parse(rawBody) as ResendEvent
    if (typeof event?.type !== 'string') return { ok: false, reason: 'body is not a Resend event' }
    return { ok: true, event }
  } catch { return { ok: false, reason: 'body is not JSON' } }
}

/** The suppression an event asks for, or null where it asks for none. */
export function suppressionFor(event: ResendEvent): { email: string; reason: 'bounce' | 'complaint'; detail?: string } | null {
  if (event.type === 'email.bounced')    return { email: event.data.to[0], reason: 'bounce', detail: event.data.bounce?.message }
  if (event.type === 'email.complained') return { email: event.data.to[0], reason: 'complaint' }
  return null
}
