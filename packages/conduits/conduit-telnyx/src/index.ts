// @frontierjs/conduit-telnyx — Telnyx messaging over conduit.
//
// NEW on this machine: the brief named `fjs-prototypes/quo/api/src/providers/
// telnyx/` as the extraction source and it is not present here, so this is
// written from the v2 API. Bearer over JSON, an Ed25519 webhook — the second
// signature family after Stripe's HMAC, which is what it brings to the
// contract argument.
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

export const TELNYX_TARGET  = 'provider:telnyx'
export const TELNYX_ADDRESS = 'https://api.telnyx.com'

export type Send = <T>(req: Omit<ConduitRequest, 'target'>) => Promise<ConduitResult<T>>
export function bindSend(conduit: { send<T>(req: ConduitRequest): Promise<ConduitResult<T>> }, target = TELNYX_TARGET): Send {
  return req => conduit.send({ target, ...req })
}

export function telnyxTarget(opts: { ref?: string; address?: string; id?: string } = {}): TargetDescriptor {
  return {
    id:            opts.id ?? TELNYX_TARGET,
    kind:          'provider',
    protocol:      'http',
    address:       opts.address ?? TELNYX_ADDRESS,
    auth:          { type: 'bearer', ref: opts.ref ?? 'TELNYX_API_KEY' },
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

export async function sendMessage(send: Send, req: {
  from:            string
  to:              string
  text?:           string
  mediaUrls?:      string[]
  /** Where Telnyx POSTs `message.sent` and `message.finalized`. */
  webhookUrl?:     string
  defaultCountry?: string
}): Promise<{ message?: TelnyxMessage; error?: TelnyxFailure }> {
  const to = toE164(req.to, req.defaultCountry), from = toE164(req.from, req.defaultCountry)
  if (!req.text && !req.mediaUrls?.length) throw new TypeError('telnyx: a message needs text or media')
  const r = await send<{ data: TelnyxMessage }>({ method: 'POST', path: '/v2/messages', body: {
    from, to,
    ...(req.text ? { text: req.text } : {}),
    ...(req.mediaUrls?.length ? { media_urls: req.mediaUrls } : {}),
    ...(req.webhookUrl ? { webhook_url: req.webhookUrl } : {}),
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
