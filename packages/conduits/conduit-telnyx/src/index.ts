// @frontierjs/conduit-telnyx — Telnyx over conduit: texts, call control,
// WebRTC credentials and the media stream.
//
// Extracted from the quo and serpgrid providers, which ran against the live
// carrier. Bearer over JSON, an Ed25519 webhook — the second signature family
// after Stripe's HMAC. Every call takes the bound `send` first; an app's
// environment, its default country and its connection ids stay in the app.
//
// `sent` and `delivered` are two columns. The send answers `queued`/`sent`;
// `delivered` arrives on `message.finalized` minutes later, and a connector
// that reported the send as delivery would be wrong in the common case.

import type { ConduitRequest, ConduitResult, TargetDescriptor } from '@frontierjs/conduit'
import { translate, type TelnyxFailure } from './errors.ts'
import type { TelnyxMessage } from './types.ts'

export * from './types.ts'
export * from './errors.ts'
export * from './verify.ts'
export * from './calls.ts'
export * from './credentials.ts'
export * from './stream.ts'

export const TELNYX_TARGET  = 'provider:telnyx'
export const TELNYX_ADDRESS = 'https://api.telnyx.com'

export type Send = <T>(req: Omit<ConduitRequest, 'target'>) => Promise<ConduitResult<T>>
export function bindSend(conduit: { send<T>(req: ConduitRequest): Promise<ConduitResult<T>> }, target = TELNYX_TARGET): Send {
  return req => conduit.send({ target, ...req })
}

/**
 * `perCaller` asks the resolver `getFor(ref, who)`, so one account's key is
 * never sent for another tenant's call (`FJS-D848`). `resilience` has no
 * default: call control shares this target and its `command_id` replays need
 * retries, while a text is never replayed once it may have left.
 */
export function telnyxTarget(opts: { ref?: string; address?: string; id?: string; perCaller?: boolean; resilience?: TargetDescriptor['resilience'] } = {}): TargetDescriptor {
  return {
    id:            opts.id ?? TELNYX_TARGET,
    kind:          'provider',
    protocol:      'http',
    address:       opts.address ?? TELNYX_ADDRESS,
    auth:          { type: 'bearer', ref: opts.ref ?? 'TELNYX_API_KEY', ...(opts.perCaller ? { per_caller: true as const } : {}) },
    ...(opts.resilience ? { resilience: opts.resilience } : {}),
    registered_at: Date.now(),
    last_seen_at:  null,
  }
}

/**
 * E.164 or nothing. `(415) 555-0100` with a default country becomes
 * `+14155550100`; anything that does not end as `+` and 8–15 digits is
 * refused HERE, because the vendor's refusal for it costs a round trip and is
 * worded for a carrier. `defaultCountry` is a calling code (`'1'`), never
 * guessed.
 */
export function toE164(input: string, defaultCountry?: string): string {
  const trimmed = input.trim()
  const digits  = trimmed.replace(/[^\d+]/g, '')
  let out: string
  if (digits.startsWith('+')) out = '+' + digits.slice(1).replace(/\D/g, '')
  else if (digits.startsWith('00')) out = '+' + digits.slice(2)
  else if (defaultCountry) out = `+${defaultCountry}${digits.replace(/^0+/, '')}`
  else throw new TypeError(`telnyx: '${input}' has no country code and no default was given`)
  if (!/^\+[1-9]\d{7,14}$/.test(out)) throw new TypeError(`telnyx: '${input}' is not an E.164 number`)
  return out
}

/** `+` and 7–15 digits, as the carrier spells a number back; `toE164` is the stricter check on what an app is about to send. */
export const isE164 = (s: unknown): s is string => typeof s === 'string' && /^\+[1-9]\d{6,14}$/.test(s)

export async function sendMessage(send: Send, req: {
  from:            string
  to:              string
  text?:           string
  mediaUrls?:      string[]
  /** Where Telnyx POSTs `message.sent` and `message.finalized`. */
  webhookUrl?:     string
  /** Overrides the profile the `from` number sits on; absent, Telnyx uses that one. */
  messagingProfileId?: string
  defaultCountry?: string
}): Promise<{ message?: TelnyxMessage; error?: TelnyxFailure }> {
  const to = toE164(req.to, req.defaultCountry), from = toE164(req.from, req.defaultCountry)
  if (!req.text && !req.mediaUrls?.length) throw new TypeError('telnyx: a message needs text or media')
  const r = await send<{ data: TelnyxMessage }>({ method: 'POST', path: '/v2/messages', body: {
    from, to,
    ...(req.text ? { text: req.text } : {}),
    ...(req.mediaUrls?.length ? { media_urls: req.mediaUrls } : {}),
    ...(req.webhookUrl ? { webhook_url: req.webhookUrl } : {}),
    ...(req.messagingProfileId ? { messaging_profile_id: req.messagingProfileId } : {}),
  } })
  if (r.error) return { error: translate(r.error) }
  return { message: r.data.data }
}

/** The read that resolves a lost response: by id, idempotent. */
export async function getMessage(send: Send, id: string): Promise<{ message?: TelnyxMessage; error?: TelnyxFailure }> {
  const r = await send<{ data: TelnyxMessage }>({ method: 'GET', path: `/v2/messages/${encodeURIComponent(id)}` })
  if (r.error) return { error: translate(r.error) }
  return { message: r.data.data }
}
