// @frontierjs/conduit-mailgun — Mailgun over conduit.
//
// The third mail vendor, chosen for RAW MIME: a route whose forward URL ends
// in `mime` posts the whole RFC 5322 message as `body-mime` and parses nothing
// for us, so this is the connector that brings the MIME parser (`FJS-D784`,
// `FJS-D1091`) — `fromMime` in ./mime.ts, which a second raw-MIME vendor (SES)
// imports rather than writes.
//
// Auth is HTTP Basic, user `api`, so the built-in `basic` signer fits and the
// credential is the string `api:<key>`. A send is form-encoded and Mailgun
// collapses nothing under any header: unkeyed, unreplayable, a lost response is
// `indeterminate`, and the read that resolves it is `events()` filtered on a
// `v:` variable the caller set (C6).
//
// Two facts about the inbound half the dialect absorbs:
//   - The signature is HMAC-SHA256 over `timestamp + token` with the webhook
//     signing key, and covers NO byte of the body. Inside the window a captured
//     signature verifies over any body, so the window is tight and `token`,
//     random per request, is spent as a nonce through conduit's `seenNonce`.
//     That pair is all that stands behind the body.
//   - There is no delivery id. A retry is a new request with a new token, so
//     the dedupe key is the mail's own Message-ID AND the recipient — one mail
//     to two of our addresses is two deliveries — and a mail with no Message-ID
//     keys on a hash of its bytes, the last stable thing a retry repeats.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { ConduitError, ConduitRequest, ConduitResult, Delivery, Dialect, TargetDescriptor } from '@frontierjs/conduit'
import type { IMail, MailMessage, MailgunErrorBody, MailgunEventsPage, MailgunForward, MailgunMailEvent, MailgunSendForm, MailgunSendResponse, SendResult } from './types.ts'
import { fromMime } from './mime.ts'

export * from './types.ts'
export { fromMime, type Envelope } from './mime.ts'

export const MAILGUN_TARGET     = 'provider:mailgun'
export const MAILGUN_ADDRESS    = 'https://api.mailgun.net'
export const MAILGUN_EU_ADDRESS = 'https://api.eu.mailgun.net'

export type Send = <T>(req: Omit<ConduitRequest, 'target'>) => Promise<ConduitResult<T>>
export function bindSend(conduit: { send<T>(req: ConduitRequest): Promise<ConduitResult<T>> }, target = MAILGUN_TARGET): Send {
  return req => conduit.send({ target, ...req })
}

/** The credential under `ref` is `api:<key>` — Basic with the fixed user Mailgun reads. An EU account passes `address: MAILGUN_EU_ADDRESS`. */
export function mailgunTarget(opts: { ref?: string; address?: string; id?: string } = {}): TargetDescriptor {
  return {
    id: opts.id ?? MAILGUN_TARGET, kind: 'provider', protocol: 'http', address: opts.address ?? MAILGUN_ADDRESS, encoding: 'form',
    auth: { type: 'signed', signer: 'basic', ref: opts.ref ?? 'MAILGUN_API_KEY' },
    registered_at: Date.now(), last_seen_at: null,
  }
}

// ─── Errors ──────────────────────────────────────────────────────────────
// A 400 is a parameter Mailgun refused, worded in `message`; a 404 is a domain
// that is not on this account, which the kind alone cannot tell from a 400.

export type MailgunFailureKind = 'refused' | 'gone' | ConduitError['kind']
export interface MailgunFailure { kind: MailgunFailureKind; message: string; retryable: boolean; retryAfterMs?: number }

export function translate(error: ConduitError, status?: number): MailgunFailure {
  let body: MailgunErrorBody | null = null
  try { body = typeof error.raw === 'string' ? JSON.parse(error.raw) : (error.raw as MailgunErrorBody) } catch { /* the 401 is the word Forbidden */ }
  const message = (body && typeof body === 'object' && body.message) || (typeof error.raw === 'string' && error.raw.trim()) || error.message
  const base: MailgunFailure = { kind: error.kind, message, retryable: error.retryable, ...(error.retry_after_ms !== undefined ? { retryAfterMs: error.retry_after_ms } : {}) }
  if (error.kind !== 'client_error') return base
  if (status === 404) return { ...base, kind: 'gone', retryable: false }
  return { ...base, kind: 'refused', retryable: false }
}

// ─── Payload ─────────────────────────────────────────────────────────────

const list = (v: string | string[] | undefined) => v === undefined ? undefined : (Array.isArray(v) ? v : [v]).join(', ')
function assertNoCrlf(v: string, what: string) { if (/[\r\n]/.test(v)) throw new Error(`mailgun: ${what} contains a line break`) }

export function toMailgunForm(msg: MailMessage, defaults: { from: string; replyTo?: string }): MailgunSendForm {
  const from = msg.from ?? defaults.from
  const to   = list(msg.to)
  if (!to) throw new Error('mailgun: at least one recipient is required')
  if (!msg.html && !msg.text) throw new Error('mailgun: html or text body is required')
  if (msg.attachments?.length)
    throw new Error('mailgun: an attachment is not sent — a target has one body encoding and this one is form, and a file needs multipart')
  for (const [what, v] of Object.entries({ from, to, subject: msg.subject })) assertNoCrlf(v, what)
  const form: MailgunSendForm = { from, to, subject: msg.subject }
  const cc  = list(msg.cc);  if (cc)  form.cc  = cc
  const bcc = list(msg.bcc); if (bcc) form.bcc = bcc
  if (msg.text) form.text = msg.text
  if (msg.html) form.html = msg.html
  const replyTo = msg.replyTo ?? defaults.replyTo
  if (replyTo) { assertNoCrlf(replyTo, 'replyTo'); form['h:Reply-To'] = replyTo }
  for (const [k, v] of Object.entries(msg.headers ?? {})) { assertNoCrlf(k, 'header name'); assertNoCrlf(v, `headers.${k}`); form[`h:${k}`] = v }
  const tags = Object.entries(msg.tags ?? {})
  if (tags.length) form['o:tag'] = `${tags[0][0]}:${tags[0][1]}`
  for (const [k, v] of tags) { assertNoCrlf(k, 'tag name'); assertNoCrlf(v, `tags.${k}`); form[`v:${k}`] = v }
  return form
}

// ─── Calls ───────────────────────────────────────────────────────────────

export type SendOutcome =
  | { id: string; message: string; error?: undefined }
  | { id?: undefined; message?: undefined; error: MailgunFailure }

const domainPath = (domain: string, rest: string) => `/v3/${encodeURIComponent(domain)}/${rest}`

/** Unkeyed and unreplayable: a retried send is a second email. A lost response is resolved by `events()`. */
export async function sendEmail(send: Send, domain: string, form: MailgunSendForm): Promise<SendOutcome> {
  const r = await send<MailgunSendResponse>({ method: 'POST', path: domainPath(domain, 'messages'), body: form })
  if (r.error) return { error: translate(r.error, r.meta.status) }
  return { id: r.data.id, message: r.data.message }
}

/**
 * The read that resolves a lost send (C6): Mailgun collapses nothing, so a
 * caller that set a `v:` variable asks here whether a mail carrying it was
 * `accepted`. `query` is Mailgun's own filter grammar, passed through.
 */
export async function events(send: Send, domain: string, query: Record<string, string | number | undefined> = {}) {
  const r = await send<MailgunEventsPage>({ method: 'GET', path: domainPath(domain, 'events'), query })
  if (r.error) return { error: translate(r.error, r.meta.status) }
  return { items: r.data.items ?? [] }
}

/** Junction's `IMail` by structure. A refusal is thrown with the failure's fields on the error. */
export function createMailgunMailer(send: Send, domain: string, defaults: { from: string; replyTo?: string }): IMail {
  const one = async (msg: MailMessage): Promise<SendResult> => {
    const r = await sendEmail(send, domain, toMailgunForm(msg, defaults))
    if (r.error) throw Object.assign(new Error(`mailgun: ${r.error.message}`), r.error)
    return { id: r.id, message: 'sent' }
  }
  return {
    send: one,
    async batch(messages) { const out: SendResult[] = []; for (const m of messages) out.push(await one(m)); return out },
  }
}

// ─── The webhook signature ───────────────────────────────────────────────

/** How far a signed timestamp may be from now, either way. A retry is re-signed, so the window costs no delivery. */
export const MAILGUN_WINDOW_S = 300

export interface MailgunSignatureFields { timestamp?: string | number; token?: string; signature?: string }

/**
 * Pure (C8). Freshness before any crypto; the compare is constant-time with
 * the length checked first; `seenNonce` spends the token so a captured request
 * is refused inside the window it would otherwise verify in. The reason is for
 * the log and never the response.
 */
export function verifyMailgunSignature(opts: {
  fields: MailgunSignatureFields; key: string; now: number; windowSeconds?: number
  seenNonce?: (nonce: string, keepSeconds: number) => boolean
}): { ok: true } | { ok: false; reason: string } {
  const window = opts.windowSeconds ?? MAILGUN_WINDOW_S
  if (!opts.key) return { ok: false, reason: 'no signing key' }
  const timestamp = String(opts.fields?.timestamp ?? ''), token = String(opts.fields?.token ?? ''), signature = String(opts.fields?.signature ?? '')
  if (!timestamp || !token || !signature) return { ok: false, reason: 'unsigned: timestamp, token and signature are required' }
  const ts = Number(timestamp)
  if (!Number.isFinite(ts) || Math.abs(opts.now - ts) > window) return { ok: false, reason: `timestamp ${timestamp} is outside the ${window}s window` }
  const expected = Buffer.from(createHmac('sha256', opts.key).update(timestamp + token).digest('hex'))
  const given    = Buffer.from(signature.toLowerCase())
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'signature does not match' }
  if (opts.seenNonce?.(token, 2 * window)) return { ok: false, reason: 'token already seen' }
  return { ok: true }
}

// ─── The dialect ─────────────────────────────────────────────────────────

const form   = (d: Delivery) => (d.body && typeof d.body === 'object' ? d.body : {}) as MailgunForward
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** What `app.conduit.receive({ provider: 'mailgun', path, dialect, credential, apply })` takes; the credential is the webhook signing key. */
export const mailgunMailDialect: Dialect<string, MailgunMailEvent> = {
  verify: (d, key, ctx) => verifyMailgunSignature({ fields: form(d), key, now: ctx.now, seenNonce: ctx.seenNonce }),
  async parse(d) {
    const f   = form(d)
    const raw = f['body-mime']
    if (typeof raw !== 'string' || !raw || !f.recipient) return null
    const mail = await fromMime(raw, { recipient: f.recipient, sender: f.sender })
    if (!mail) return null
    return { id: mail.headers['Message-ID'] || `sha256:${sha256(raw)}`, type: 'mail', payload: mail }
  },
  dedupeKey: (_d, ev) => `${ev.payload.recipient.trim().toLowerCase()} ${ev.id}`,
}
