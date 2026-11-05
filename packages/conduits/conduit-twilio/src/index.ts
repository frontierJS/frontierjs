// @frontierjs/conduit-twilio — Twilio Programmable Messaging over conduit.
//
// The second carrier after Telnyx, and what it shows is which SMS rules are
// shared: E.164 and the STOP/HELP keyword set are copied from telnyx verbatim
// (CONTRACT C12 says the `sms` helper is named for promotion once both exist;
// they now do). What is Twilio's alone: Basic auth (`AccountSid:AuthToken`)
// through conduit's built-in `basic` signer, form-encoded bodies, a per-account path, error
// CODES in the body, and a webhook signed HMAC-SHA1 over the public URL plus
// the sorted form fields — with no timestamp, so replay is the app's
// `MessageSid` dedupe.

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { ConduitError, ConduitRequest, ConduitResult, TargetDescriptor } from '@frontierjs/conduit'

export const TWILIO_TARGET  = 'provider:twilio'
export const TWILIO_ADDRESS = 'https://api.twilio.com'

export type Send = <T>(req: Omit<ConduitRequest, 'target'>) => Promise<ConduitResult<T>>
export function bindSend(conduit: { send<T>(req: ConduitRequest): Promise<ConduitResult<T>> }, target = TWILIO_TARGET): Send {
  return req => conduit.send({ target, ...req })
}

export function twilioTarget(opts: { ref?: string; address?: string; id?: string } = {}): TargetDescriptor {
  return {
    id: opts.id ?? TWILIO_TARGET, kind: 'provider', protocol: 'http', address: opts.address ?? TWILIO_ADDRESS, encoding: 'form',
    auth: { type: 'signed', signer: 'basic', ref: opts.ref ?? 'TWILIO_CREDENTIAL' }, registered_at: Date.now(), last_seen_at: null,
  }
}

// ─── Shapes ──────────────────────────────────────────────────────────────

export interface TwilioMessage {
  sid: string; account_sid: string; from: string; to: string; body: string
  status: 'queued' | 'sending' | 'sent' | 'delivered' | 'undelivered' | 'failed' | 'received' | (string & {})
  error_code: number | null; error_message: string | null; date_sent: string | null; num_segments: string
}
export interface TwilioErrorBody { code?: number; message?: string; more_info?: string; status?: number }
export type Keyword = 'STOP' | 'START' | 'HELP' | null

// ─── Errors ──────────────────────────────────────────────────────────────

export type TwilioFailureKind = 'opted_out' | 'invalid_destination' | 'unregistered' | 'refused' | ConduitError['kind']
export interface TwilioFailure { kind: TwilioFailureKind; code?: number; message: string; retryable: boolean; retryAfterMs?: number }

/** Twilio's error catalog, the codes a send can answer with. 30xxx arrive on the status webhook, not the send. */
export const OPTED_OUT_CODES          = new Set([21610])
export const INVALID_DESTINATION_CODES = new Set([21211, 21614, 21217, 21408])
export const UNREGISTERED_CODES       = new Set([30034, 21608])

export function translate(error: ConduitError): TwilioFailure {
  let body: TwilioErrorBody | null = null
  try { body = typeof error.raw === 'string' ? JSON.parse(error.raw) : (error.raw as TwilioErrorBody) } catch { /* not JSON */ }
  const base: TwilioFailure = { kind: error.kind, message: body?.message ?? error.message, retryable: error.retryable,
    ...(body?.code !== undefined ? { code: body.code } : {}), ...(error.retry_after_ms !== undefined ? { retryAfterMs: error.retry_after_ms } : {}) }
  if (error.kind !== 'client_error' || body?.code === undefined) return base
  if (OPTED_OUT_CODES.has(body.code))           return { ...base, kind: 'opted_out', retryable: false }
  if (INVALID_DESTINATION_CODES.has(body.code)) return { ...base, kind: 'invalid_destination', retryable: false }
  if (UNREGISTERED_CODES.has(body.code))        return { ...base, kind: 'unregistered', retryable: false }
  return { ...base, kind: 'refused', retryable: false }
}

// ─── Rules shared with telnyx (copied, pending the sms helper) ────────────

export function toE164(input: string, defaultCountry?: string): string {
  const digits = input.trim().replace(/[^\d+]/g, '')
  let out: string
  if (digits.startsWith('+')) out = '+' + digits.slice(1).replace(/\D/g, '')
  else if (digits.startsWith('00')) out = '+' + digits.slice(2)
  else if (defaultCountry) out = `+${defaultCountry}${digits.replace(/^0+/, '')}`
  else throw new TypeError(`twilio: '${input}' has no country code and no default was given`)
  if (!/^\+[1-9]\d{7,14}$/.test(out)) throw new TypeError(`twilio: '${input}' is not an E.164 number`)
  return out
}
export function keywordOf(text: string | undefined | null): Keyword {
  const w = (text ?? '').trim().toUpperCase()
  if (['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'].includes(w)) return 'STOP'
  if (['START', 'UNSTOP', 'YES'].includes(w)) return 'START'
  if (['HELP', 'INFO'].includes(w)) return 'HELP'
  return null
}

// ─── Calls ───────────────────────────────────────────────────────────────

export async function sendMessage(send: Send, req: {
  accountSid: string; from?: string; messagingServiceSid?: string; to: string; body?: string; mediaUrls?: string[]
  /** Where Twilio POSTs delivery status, minutes later. */
  statusCallback?: string; defaultCountry?: string
}): Promise<{ message?: TwilioMessage; error?: TwilioFailure }> {
  const to = toE164(req.to, req.defaultCountry)
  if (!req.from && !req.messagingServiceSid) throw new TypeError('twilio: a message needs From or MessagingServiceSid')
  if (!req.body && !req.mediaUrls?.length) throw new TypeError('twilio: a message needs Body or MediaUrl')
  if (req.body && req.body.length > 1600) throw new TypeError('twilio: Body is over 1600 characters, which Twilio refuses')
  const r = await send<TwilioMessage>({
    method: 'POST', path: `/2010-04-01/Accounts/${encodeURIComponent(req.accountSid)}/Messages.json`,
    body: {
      To: to,
      ...(req.from ? { From: toE164(req.from, req.defaultCountry) } : { MessagingServiceSid: req.messagingServiceSid }),
      ...(req.body ? { Body: req.body } : {}),
      ...(req.mediaUrls?.length ? { MediaUrl: req.mediaUrls } : {}),
      ...(req.statusCallback ? { StatusCallback: req.statusCallback } : {}),
    },
  })
  if (r.error) return { error: translate(r.error) }
  return { message: r.data }
}

export async function getMessage(send: Send, accountSid: string, sid: string): Promise<{ message?: TwilioMessage; error?: TwilioFailure }> {
  const r = await send<TwilioMessage>({ method: 'GET', path: `/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages/${encodeURIComponent(sid)}.json` })
  if (r.error) return { error: translate(r.error) }
  return { message: r.data }
}

// ─── Inbound ─────────────────────────────────────────────────────────────

export type Verified = { ok: true; params: Record<string, string>; keyword: Keyword } | { ok: false; reason: string }

/**
 * `X-Twilio-Signature` is base64(HMAC-SHA1(authToken, url + Σ sorted key+value)).
 * `url` is the PUBLIC URL Twilio was given, exactly — scheme, host, port and
 * query included — which is why it is an argument: behind a proxy the request's
 * own URL is a different string and the signature fails for every event. No
 * timestamp is in the scheme, so freshness is not checked here; replay is the
 * app's `MessageSid` dedupe.
 */
export function verifyTwilioSignature(opts: { url: string; rawBody: string; header: string | null | undefined; authToken: string | undefined }): Verified {
  if (!opts.authToken) return { ok: false, reason: 'no auth token is configured on this side' }
  if (!opts.header) return { ok: false, reason: 'no X-Twilio-Signature header' }
  const params = Object.fromEntries(new URLSearchParams(opts.rawBody))
  const data = opts.url + Object.keys(params).sort().map(k => k + params[k]).join('')
  const want = Buffer.from(createHmac('sha1', opts.authToken).update(data).digest('base64'))
  const have = Buffer.from(opts.header)
  if (have.length !== want.length || !timingSafeEqual(have, want)) return { ok: false, reason: 'signature does not match' }
  return { ok: true, params, keyword: keywordOf(params.Body) }
}
