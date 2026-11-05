// src/verify.ts — is this really Telnyx?
//
// Telnyx signs `"<telnyx-timestamp>|<raw body>"` with an Ed25519 key per
// account and sends the signature base64 in `telnyx-signature-ed25519`. The
// public key is the account's, base64, read from the portal. Over the raw
// bytes, `now` an argument, freshness before the verify so a stale replay
// costs no curve operation. WebCrypto, which Bun 1.4 has for Ed25519.

import type { TelnyxEvent, Keyword } from './types.ts'

export const TELNYX_TOLERANCE_SECONDS = 300

export type Verified = { ok: true; event: TelnyxEvent } | { ok: false; reason: string }

const keys = new Map<string, Promise<CryptoKey>>()
function publicKey(b64: string): Promise<CryptoKey> {
  let k = keys.get(b64)
  if (!k) { k = crypto.subtle.importKey('raw', Buffer.from(b64, 'base64'), { name: 'Ed25519' }, false, ['verify']); keys.set(b64, k) }
  return k
}

export async function verifyTelnyxSignature(opts: {
  rawBody:           string
  headers:           { 'telnyx-signature-ed25519'?: string | null; 'telnyx-timestamp'?: string | null }
  publicKey:         string | undefined
  now:               number
  toleranceSeconds?: number
}): Promise<Verified> {
  const { rawBody, headers, now, toleranceSeconds = TELNYX_TOLERANCE_SECONDS } = opts
  if (!opts.publicKey) return { ok: false, reason: 'no Telnyx public key is configured on this side' }
  const sig = headers['telnyx-signature-ed25519'], ts = headers['telnyx-timestamp']
  if (!sig || !ts) return { ok: false, reason: 'telnyx signature headers are missing' }
  const seconds = Number(ts)
  if (!Number.isFinite(seconds)) return { ok: false, reason: 'timestamp is not a number' }
  const skew = Math.abs(now - seconds)
  if (skew > toleranceSeconds) return { ok: false, reason: `timestamp is ${skew}s out, tolerance is ${toleranceSeconds}s` }
  let ok = false
  try {
    ok = await crypto.subtle.verify('Ed25519', await publicKey(opts.publicKey), Buffer.from(sig, 'base64'), new TextEncoder().encode(`${ts}|${rawBody}`))
  } catch { return { ok: false, reason: 'public key or signature is malformed' } }
  if (!ok) return { ok: false, reason: 'signature does not match' }
  try {
    const event = JSON.parse(rawBody) as TelnyxEvent
    if (typeof event?.data?.event_type !== 'string') return { ok: false, reason: 'body is not a Telnyx event' }
    return { ok: true, event }
  } catch { return { ok: false, reason: 'body is not JSON' } }
}

/**
 * The legally meaningful words in an inbound text. Case-insensitive, the
 * whole message trimmed, because "Stop" and "STOP " are both an opt-out and a
 * carrier may or may not have handled it before it reached us. UNSUBSCRIBE,
 * CANCEL, END and QUIT are the CTIA set; UNSTOP joins START.
 */
export function keywordOf(text: string | undefined | null): Keyword {
  const w = (text ?? '').trim().toUpperCase()
  if (['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'].includes(w)) return 'STOP'
  if (['START', 'UNSTOP', 'YES'].includes(w)) return 'START'
  if (['HELP', 'INFO'].includes(w)) return 'HELP'
  return null
}
