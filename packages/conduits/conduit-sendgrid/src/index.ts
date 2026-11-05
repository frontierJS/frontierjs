// @frontierjs/conduit-sendgrid — SendGrid over conduit.
//
// Written from two callers (kos `domain/mail/sendgrid.ts`, the maid.tech port's
// `integrations/sendgrid/`): bearer over JSON, a 202 whose only answer is the
// `X-Message-Id` header, event webhooks signed ECDSA P-256 over
// `timestamp + rawBody`, and a sending-domain lifecycle whose output is three
// CNAMEs the APP's DNS writer applies — never this package.
//
// `custom_args.messageId` is the thread between a send and its events: the
// row's own id goes out on the mail and comes back flat on every event, so a
// webhook finds its row before it knows SendGrid's id.

import { createPublicKey, verify as ecdsaVerify } from 'node:crypto'
import type { ConduitError, ConduitRequest, ConduitResult, TargetDescriptor } from '@frontierjs/conduit'
import type { DnsRecord, IMail, MailMessage, SendgridAddress, SendgridDomain, SendgridErrorBody, SendgridEvent, SendgridPayload, SendResult } from './types.ts'

export * from './types.ts'

export const SENDGRID_TARGET  = 'provider:sendgrid'
export const SENDGRID_ADDRESS = 'https://api.sendgrid.com'

export type Send = <T>(req: Omit<ConduitRequest, 'target'>) => Promise<ConduitResult<T>>
export function bindSend(conduit: { send<T>(req: ConduitRequest): Promise<ConduitResult<T>> }, target = SENDGRID_TARGET): Send {
  return req => conduit.send({ target, ...req })
}

/** One target per process: a SendGrid key is the account's, and the sending domains under it are its tenants' (`FJS-1020`). */
export function sendgridTarget(opts: { ref?: string; address?: string; id?: string } = {}): TargetDescriptor {
  return {
    id:            opts.id ?? SENDGRID_TARGET,
    kind:          'provider',
    protocol:      'http',
    address:       (opts.address ?? SENDGRID_ADDRESS).replace(/\/$/, ''),
    auth:          { type: 'bearer', ref: opts.ref ?? 'SENDGRID_API_KEY' },
    registered_at: Date.now(),
    last_seen_at:  null,
  }
}

// ─── Errors ──────────────────────────────────────────────────────────────
// Every refusal is `{ errors: [{ message, field, help }] }`. The kind cannot
// tell a 400 from a 403 from a 413, so the status is read beside the body.

export type SendgridFailureKind = 'refused' | 'forbidden' | 'too_large' | 'gone' | ConduitError['kind']
export interface SendgridFailure { kind: SendgridFailureKind; message: string; field?: string; retryable: boolean; retryAfterMs?: number }

export function translate(error: ConduitError, status?: number): SendgridFailure {
  let body: SendgridErrorBody | null = null
  try { body = typeof error.raw === 'string' ? JSON.parse(error.raw) : (error.raw as SendgridErrorBody) } catch { /* not JSON */ }
  const first = body?.errors?.[0]
  const base: SendgridFailure = {
    kind: error.kind, message: first?.message ?? error.message, retryable: error.retryable,
    ...(first?.field ? { field: first.field } : {}),
    ...(error.retry_after_ms !== undefined ? { retryAfterMs: error.retry_after_ms } : {}),
  }
  if (error.kind === 'auth_failed' && status === 403) return { ...base, kind: 'forbidden', retryable: false }
  if (error.kind !== 'client_error') return base
  if (status === 404) return { ...base, kind: 'gone', retryable: false }
  if (status === 413) return { ...base, kind: 'too_large', retryable: false }
  return { ...base, kind: 'refused', retryable: false }
}

// ─── Send ────────────────────────────────────────────────────────────────

const list = (v: string | string[] | undefined): SendgridAddress[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]).map(parseAddress)

/** `Name <a@b.c>` or `a@b.c` → `{ email, name? }`. Refused without an `@`: SendGrid's 400 for it costs a round trip (C9). */
export function parseAddress(input: string): SendgridAddress {
  const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^<>\s]+@[^<>\s]+)>\s*$/.exec(input)
  const email = m ? m[2] : input.trim()
  if (!email.includes('@')) throw new TypeError(`sendgrid: '${input}' is not an email address`)
  return m?.[1]?.trim() ? { email, name: m[1].trim() } : { email }
}

/**
 * A `MailMessage` as SendGrid's payload. `messageId` rides `custom_args`;
 * `sandbox` is `mail_settings.sandbox_mode`, which validates and sends nothing.
 * A `replyTo` with no address is refused here: SendGrid answers 400 for it,
 * and the maid.tech port learned that from the vendor.
 */
export function toSendgridPayload(msg: MailMessage, defaults: { from: string; replyTo?: string }, opts: { messageId?: string; sandbox?: boolean } = {}): SendgridPayload {
  const to = list(msg.to)
  if (!to.length) throw new TypeError('sendgrid: a message needs at least one recipient')
  if (!msg.text && !msg.html) throw new TypeError('sendgrid: a message needs text or html')
  const replyTo = msg.replyTo ?? defaults.replyTo
  if (replyTo !== undefined && !replyTo.includes('@')) throw new TypeError(`sendgrid: replyTo '${replyTo}' has no address — SendGrid refuses a reply_to without one`)
  const cc = list(msg.cc), bcc = list(msg.bcc)
  const customArgs = { ...(msg.tags ?? {}), ...(opts.messageId ? { messageId: opts.messageId } : {}) }
  return {
    personalizations: [{ to, ...(cc.length ? { cc } : {}), ...(bcc.length ? { bcc } : {}) }],
    from:    parseAddress(msg.from ?? defaults.from),
    ...(replyTo ? { reply_to: parseAddress(replyTo) } : {}),
    subject: msg.subject || '(no subject)',
    content: [
      ...(msg.text ? [{ type: 'text/plain' as const, value: msg.text }] : []),
      ...(msg.html ? [{ type: 'text/html' as const, value: msg.html }] : []),
    ],
    ...(msg.attachments?.length ? { attachments: msg.attachments.map(a => ({
      filename: a.filename, content: toBase64(a.content), ...(a.type ? { type: a.type } : {}),
      ...(a.cid ? { disposition: 'inline' as const, content_id: a.cid } : { disposition: 'attachment' as const }),
    })) } : {}),
    ...(msg.headers && Object.keys(msg.headers).length ? { headers: msg.headers } : {}),
    ...(Object.keys(customArgs).length ? { custom_args: customArgs } : {}),
    ...(opts.sandbox ? { mail_settings: { sandbox_mode: { enable: true } } } : {}),
  }
}

const toBase64 = (c: ArrayBuffer | Uint8Array | string) =>
  typeof c === 'string' ? Buffer.from(c).toString('base64') : Buffer.from(c instanceof Uint8Array ? c : new Uint8Array(c)).toString('base64')

export type SendOutcome = { id: string; error?: undefined } | { id?: undefined; error: SendgridFailure }

/**
 * Unkeyed and unreplayable: SendGrid collapses nothing, so a retried send is a
 * second email. A 202 has no body; the id is the `X-Message-Id` header, and a
 * sandbox send answers 200 with no id at all, which `id: ''` says. A lost
 * response is `indeterminate` and its resolving read is the Email Activity
 * API filtered by `unique_args`, a paid add-on this package names and does not
 * build (README § Lost sends).
 */
export async function sendEmail(send: Send, payload: SendgridPayload): Promise<SendOutcome> {
  const r = await send<null>({ method: 'POST', path: '/v3/mail/send', body: payload })
  if (r.error) return { error: translate(r.error, r.meta.status) }
  return { id: r.meta.headers?.['x-message-id'] ?? '' }
}

/** Junction's `IMail` by structure. A refusal is thrown with the failure's fields on the error. */
export function createSendgridMailer(send: Send, defaults: { from: string; replyTo?: string; sandbox?: boolean }): IMail {
  const one = async (msg: MailMessage): Promise<SendResult> => {
    const r = await sendEmail(send, toSendgridPayload(msg, defaults, { sandbox: defaults.sandbox, messageId: msg.tags?.messageId }))
    if (r.error) throw Object.assign(new Error(`sendgrid: ${r.error.message}`), r.error)
    return { id: r.id, message: 'sent' }
  }
  return {
    send: one,
    async batch(messages) { const out: SendResult[] = []; for (const m of messages) out.push(await one(m)); return out },
  }
}

// ─── The event webhook signature ─────────────────────────────────────────

/** How far a signed timestamp may be from now, either way. Events are retried re-signed, so the window costs no delivery. */
export const SENDGRID_WINDOW_S = 300

/**
 * ECDSA P-256 / SHA-256 over `timestamp + rawBody`, DER signature and SPKI
 * public key both base64, as the Event Webhook settings page shows them.
 * Pure, takes the clock, freshness before any crypto, and the reason is for
 * the log. The body is a JSON ARRAY of events; dedupe is by `sg_event_id`,
 * which the app keeps (C12).
 */
export function verifySendgridSignature(opts: {
  rawBody: string
  headers: { 'x-twilio-email-event-webhook-signature'?: string | null; 'x-twilio-email-event-webhook-timestamp'?: string | null }
  publicKey: string
  now: number
  windowS?: number
}): { ok: true; events: SendgridEvent[] } | { ok: false; reason: string } {
  const sig = opts.headers['x-twilio-email-event-webhook-signature'], ts = opts.headers['x-twilio-email-event-webhook-timestamp']
  if (!sig || !ts) return { ok: false, reason: 'missing signature headers' }
  const t = Number(ts)
  if (!Number.isFinite(t)) return { ok: false, reason: 'timestamp is not a number' }
  if (Math.abs(opts.now - t) > (opts.windowS ?? SENDGRID_WINDOW_S)) return { ok: false, reason: 'timestamp outside the window' }
  let ok = false
  try {
    const key = createPublicKey({ key: Buffer.from(opts.publicKey.trim(), 'base64'), format: 'der', type: 'spki' })
    ok = ecdsaVerify('sha256', Buffer.from(ts + opts.rawBody), key, Buffer.from(sig, 'base64'))
  } catch { return { ok: false, reason: 'public key or signature is not well-formed' } }
  if (!ok) return { ok: false, reason: 'signature mismatch' }
  try {
    const events = JSON.parse(opts.rawBody)
    if (!Array.isArray(events)) return { ok: false, reason: 'body is not an array of events' }
    return { ok: true, events }
  } catch { return { ok: false, reason: 'body is not JSON' } }
}

// ─── Sending domains ─────────────────────────────────────────────────────
// The lifecycle maid.tech's legacy CRM ran per tenant: authenticate → apply
// the CNAMEs → validate with backoff until DNS propagates → only then promote
// the from-address. The verbs here RETURN the records; `conduit-cloudflare`
// writes them, and a DNS writer in this package would be a second owner of
// that seam (Invariants 4 and 5).

export type DomainOutcome = { domain: SendgridDomain; error?: undefined } | { domain?: undefined; error: SendgridFailure }

/** A create is unkeyed and SendGrid refuses a duplicate domain by name, so a lost answer is resolved by `listDomains`. */
export async function authenticateDomain(send: Send, opts: { domain: string; subdomain?: string; default?: boolean }): Promise<DomainOutcome> {
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(opts.domain)) return { error: { kind: 'refused', message: `'${opts.domain}' is not a domain name`, retryable: false } }
  const r = await send<SendgridDomain>({ method: 'POST', path: '/v3/whitelabel/domains', body: {
    domain: opts.domain, subdomain: opts.subdomain ?? 'mail', automatic_security: true, default: opts.default ?? false,
  } })
  if (r.error) return { error: translate(r.error, r.meta.status) }
  return { domain: r.data }
}

/** Flips `valid` once the CNAMEs resolve. Idempotent and free, so the caller polls it with backoff. */
export async function validateDomain(send: Send, id: number): Promise<DomainOutcome> {
  const r = await send<{ id: number; valid: boolean; validation_results?: unknown }>({ method: 'POST', path: `/v3/whitelabel/domains/${id}/validate`, replayable: true })
  if (r.error) return { error: translate(r.error, r.meta.status) }
  const g = await getDomain(send, id)
  return g.error ? g : { domain: { ...g.domain, valid: r.data.valid } }
}

export async function getDomain(send: Send, id: number): Promise<DomainOutcome> {
  const r = await send<SendgridDomain>({ method: 'GET', path: `/v3/whitelabel/domains/${id}` })
  if (r.error) return { error: translate(r.error, r.meta.status) }
  return { domain: r.data }
}

/** The read that resolves a lost `authenticateDomain` (C6): the account's domains, which the caller matches by name. */
export async function listDomains(send: Send): Promise<{ domains: SendgridDomain[]; error?: undefined } | { domains?: undefined; error: SendgridFailure }> {
  const r = await send<SendgridDomain[]>({ method: 'GET', path: '/v3/whitelabel/domains' })
  if (r.error) return { error: translate(r.error, r.meta.status) }
  return { domains: r.data }
}

export async function removeDomain(send: Send, id: number): Promise<{ error?: SendgridFailure }> {
  const r = await send<null>({ method: 'DELETE', path: `/v3/whitelabel/domains/${id}`, replayable: true })
  return r.error ? { error: translate(r.error, r.meta.status) } : {}
}

/** The three CNAMEs as a DNS writer takes them. `proxied: false` is stated on every record because a proxied one never resolves for DKIM. */
export function dnsRecordsOf(domain: SendgridDomain): DnsRecord[] {
  return Object.values(domain.dns ?? {}).map(r => ({ type: 'CNAME', name: r.host, content: r.data, proxied: false }))
}
