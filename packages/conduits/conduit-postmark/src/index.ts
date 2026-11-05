// @frontierjs/conduit-postmark — Postmark over conduit.
//
// The second mail vendor, chosen for INBOUND: Postmark delivers a parsed
// message to a webhook, which `inbound-email.md` needs a provider for, and it
// is the second mailer `FJS-D684`'s `SendResult.id` ruling has to argue with
// (`MessageID`, a GUID, against Resend's `id`).
//
// Auth is a header, `X-Postmark-Server-Token`, so the `api_key` type fits.
// A send is not idempotent and Postmark honors no idempotency header: unkeyed,
// unreplayable, a lost response is `indeterminate`.
//
// Postmark SIGNS NOTHING. The inbound verifier is a constant-time compare of
// the Basic credential the app put in the webhook URL, plus an optional IP
// allow-list — it authenticates the URL, not the request (CONTRACT C8's
// third family). The README says so in its first paragraph.

import { timingSafeEqual } from 'node:crypto'
import type { ConduitError, ConduitRequest, ConduitResult, Dialect, TargetDescriptor } from '@frontierjs/conduit'
import { formatMailbox } from '@frontierjs/toolbelt/mailbox'
import type { MailMessage, PostmarkEmail, PostmarkSendResponse, PostmarkErrorBody, PostmarkInbound, PostmarkBounce, PostmarkMailEvent, ReceivedMail, SendResult } from './types.ts'

export * from './types.ts'

export const POSTMARK_TARGET  = 'provider:postmark'
export const POSTMARK_ADDRESS = 'https://api.postmarkapp.com'

export type Send = <T>(req: Omit<ConduitRequest, 'target'>) => Promise<ConduitResult<T>>
export function bindSend(conduit: { send<T>(req: ConduitRequest): Promise<ConduitResult<T>> }, target = POSTMARK_TARGET): Send {
  return req => conduit.send({ target, ...req })
}

export function postmarkTarget(opts: { ref?: string; address?: string; id?: string } = {}): TargetDescriptor {
  return {
    id: opts.id ?? POSTMARK_TARGET, kind: 'provider', protocol: 'http', address: opts.address ?? POSTMARK_ADDRESS,
    auth: { type: 'api_key', header: 'X-Postmark-Server-Token', ref: opts.ref ?? 'POSTMARK_SERVER_TOKEN' },
    registered_at: Date.now(), last_seen_at: null,
  }
}

// ─── Errors ──────────────────────────────────────────────────────────────
// Postmark answers 422 with its own `ErrorCode`, and the two that matter are
// not the same failure: 300 is OUR address being malformed, 406 is a
// recipient Postmark has already bounced and will not send to again.

export type PostmarkFailureKind = 'refused' | 'suppressed' | ConduitError['kind']
export interface PostmarkFailure { kind: PostmarkFailureKind; code?: number; message: string; retryable: boolean; retryAfterMs?: number }

export function translate(error: ConduitError): PostmarkFailure {
  let body: PostmarkErrorBody | null = null
  try { body = typeof error.raw === 'string' ? JSON.parse(error.raw) : (error.raw as PostmarkErrorBody) } catch { /* not JSON */ }
  const base: PostmarkFailure = { kind: error.kind, message: body?.Message ?? error.message, retryable: error.retryable,
    ...(body?.ErrorCode !== undefined ? { code: body.ErrorCode } : {}), ...(error.retry_after_ms !== undefined ? { retryAfterMs: error.retry_after_ms } : {}) }
  if (error.kind !== 'client_error') return base
  if (body?.ErrorCode === 406) return { ...base, kind: 'suppressed', retryable: false }
  return { ...base, kind: 'refused', retryable: false }
}

// ─── Payload ─────────────────────────────────────────────────────────────

const list = (v: string | string[] | undefined) => v === undefined ? undefined : (Array.isArray(v) ? v : [v]).join(', ')
const b64 = (c: ArrayBuffer | Uint8Array | string) => typeof c === 'string' ? c : Buffer.from(c instanceof ArrayBuffer ? new Uint8Array(c) : c).toString('base64')
function assertNoCrlf(v: string, what: string) { if (/[\r\n]/.test(v)) throw new Error(`postmark: ${what} contains a line break`) }

export function toPostmarkPayload(msg: MailMessage, defaults: { from: string; replyTo?: string; stream?: string }): PostmarkEmail {
  const from = msg.from ?? defaults.from
  const to = list(msg.to)
  if (!to) throw new Error('postmark: at least one recipient is required')
  if (!msg.html && !msg.text) throw new Error('postmark: html or text body is required')
  for (const [what, v] of Object.entries({ from, to, subject: msg.subject })) assertNoCrlf(v, what)
  for (const [k, v] of Object.entries(msg.headers ?? {})) { assertNoCrlf(k, 'header name'); assertNoCrlf(v, `headers.${k}`) }
  // Postmark takes ONE tag; the rest of the map goes to Metadata so nothing is dropped.
  const tags = Object.entries(msg.tags ?? {})
  return {
    From: from, To: to, Subject: msg.subject,
    ...(msg.html ? { HtmlBody: msg.html } : {}), ...(msg.text ? { TextBody: msg.text } : {}),
    ...((msg.replyTo ?? defaults.replyTo) ? { ReplyTo: msg.replyTo ?? defaults.replyTo } : {}),
    ...(msg.cc ? { Cc: list(msg.cc) } : {}), ...(msg.bcc ? { Bcc: list(msg.bcc) } : {}),
    ...(msg.headers ? { Headers: Object.entries(msg.headers).map(([Name, Value]) => ({ Name, Value })) } : {}),
    ...(tags.length ? { Tag: `${tags[0][0]}:${tags[0][1]}`, Metadata: Object.fromEntries(tags) } : {}),
    ...(msg.attachments?.length ? { Attachments: msg.attachments.map(a => ({ Name: a.filename, Content: b64(a.content), ContentType: a.type ?? 'application/octet-stream', ...(a.cid ? { ContentID: `cid:${a.cid}` } : {}) })) } : {}),
    ...(defaults.stream ? { MessageStream: defaults.stream } : {}),
  }
}

export async function sendEmail(send: Send, email: PostmarkEmail): Promise<{ id?: string; error?: PostmarkFailure }> {
  const r = await send<PostmarkSendResponse>({ method: 'POST', path: '/email', body: email })
  if (r.error) return { error: translate(r.error) }
  return { id: r.data.MessageID }
}

/** A batch answers 200 with a PER-MESSAGE status: one bad address does not
 *  fail the rest, and `ErrorCode: 0` is the only success. */
export async function sendBatch(send: Send, emails: PostmarkEmail[]): Promise<{ results?: ({ id: string } | { error: PostmarkFailure })[]; error?: PostmarkFailure }> {
  if (emails.length > 500) return { error: { kind: 'refused', message: 'Postmark takes at most 500 messages per batch', retryable: false } }
  const r = await send<PostmarkSendResponse[]>({ method: 'POST', path: '/email/batch', body: emails })
  if (r.error) return { error: translate(r.error) }
  return { results: r.data.map(x => x.ErrorCode === 0 ? { id: x.MessageID } : { error: { kind: x.ErrorCode === 406 ? 'suppressed' : 'refused', code: x.ErrorCode, message: x.Message, retryable: false } }) }
}

export function createPostmarkMailer(send: Send, defaults: { from: string; replyTo?: string; stream?: string }) {
  const raise = (f: PostmarkFailure): never => { throw Object.assign(new Error(`Postmark: ${f.kind} — ${f.message}`), { kind: f.kind, retryable: f.retryable }) }
  return {
    async send(message: MailMessage): Promise<SendResult> {
      const r = await sendEmail(send, toPostmarkPayload(message, defaults))
      if (r.error) raise(r.error)
      return { id: r.id!, message: 'sent' }
    },
    async batch(messages: MailMessage[]): Promise<SendResult[]> {
      const r = await sendBatch(send, messages.map(m => toPostmarkPayload(m, defaults)))
      if (r.error) raise(r.error)
      return r.results!.map(x => 'id' in x ? { id: x.id, message: 'sent' } : { id: '', message: `failed: ${x.error.message}` })
    },
  }
}

// ─── Inbound ─────────────────────────────────────────────────────────────

export type Verified<T> = { ok: true; event: T } | { ok: false; reason: string }

const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y) }

/**
 * Postmark signs nothing, so this authenticates the URL: the Basic credential
 * the app embedded in the webhook address, compared constant-time, and an
 * optional allow-list of Postmark's sending addresses. It takes `ip` and
 * `authorization` as inputs because a verifier reads no request.
 */
export function verifyPostmarkWebhook<T = PostmarkInbound | PostmarkBounce>(opts: {
  rawBody:       string
  authorization: string | null | undefined
  credential:    string | undefined        // "user:pass", what the URL carries
  ip?:           string | null
  allowIps?:     string[]
}): Verified<T> {
  if (!opts.credential) return { ok: false, reason: 'no webhook credential is configured on this side' }
  if (!opts.authorization?.startsWith('Basic ')) return { ok: false, reason: 'no Basic credential on the request' }
  let presented = ''
  try { presented = Buffer.from(opts.authorization.slice(6), 'base64').toString('utf8') } catch { return { ok: false, reason: 'credential is not base64' } }
  if (!same(presented, opts.credential)) return { ok: false, reason: 'credential does not match' }
  if (opts.allowIps?.length && !(opts.ip && opts.allowIps.includes(opts.ip))) return { ok: false, reason: `source ${opts.ip ?? '(unknown)'} is not a Postmark address` }
  try {
    const event = JSON.parse(opts.rawBody) as T
    if (!event || typeof event !== 'object') return { ok: false, reason: 'body is not a Postmark payload' }
    return { ok: true, event }
  } catch { return { ok: false, reason: 'body is not JSON' } }
}

// ─── The mail dialect ─────────────────────────────────────────────────────
// What `app.conduit.receive()` takes for Postmark's inbound webhook (FJS-D899,
// FJS-D1091): verify is the URL credential above, parse is the rename from
// Postmark's PascalCase to `ReceivedMail`, and the dedupe key is Postmark's own
// `MessageID` — its id for the DELIVERY, which a retry repeats. The mail's own
// Message-ID is a header like any other, under `headers`. No IP allow-list here:
// a `Delivery` carries no peer address, so an app that wants one grades it at
// the route. A bounce posted at the same path is not a mail and is ignored.

/** Postmark's parsed message as a `ReceivedMail`, or null for a body that is not one. */
export function toReceivedMail(b: PostmarkInbound): ReceivedMail | null {
  if (!b || typeof b !== 'object' || !b.MessageID || typeof b.To !== 'string') return null
  const recipient = (b.OriginalRecipient ?? b.ToFull?.[0]?.Email ?? b.To.split(',')[0] ?? '').trim()
  if (!recipient) return null
  const fromEmail = (b.FromFull?.Email ?? b.From ?? '').trim()
  if (!fromEmail) return null
  const headers = Object.fromEntries((b.Headers ?? []).filter(h => h?.Name).map(h => [h.Name, h.Value ?? '']))
  const attachments = (b.Attachments ?? []).map(a => ({
    filename: a.Name || 'attachment',
    content:  new Uint8Array(Buffer.from(a.Content ?? '', 'base64')),
    type:     a.ContentType || 'application/octet-stream',
    ...(a.ContentID ? { cid: a.ContentID.replace(/^cid:/, '').replace(/^<|>$/g, '') } : {}),
  }))
  return {
    recipient,
    to:      b.To,
    from:    formatMailbox(fromEmail, b.FromFull?.Name ?? b.FromName),
    subject: b.Subject ?? '',
    ...(b.Cc ? { cc: b.Cc } : {}),
    ...(b.TextBody !== undefined ? { text: b.TextBody } : {}),
    ...(b.HtmlBody !== undefined ? { html: b.HtmlBody } : {}),
    headers,
    attachments,
  }
}

export const postmarkMailDialect: Dialect<string, PostmarkMailEvent> = {
  verify(d, cred) {
    const v = verifyPostmarkWebhook({ rawBody: d.rawBody, authorization: d.headers.authorization, credential: cred })
    return v.ok ? { ok: true } : { ok: false, reason: v.reason }
  },
  parse(d) {
    const b = d.body as PostmarkInbound | PostmarkBounce | null
    if (!b || typeof b !== 'object' || 'RecordType' in b) return null
    const mail = toReceivedMail(b)
    return mail ? { id: b.MessageID, type: 'mail', payload: mail } : null
  },
  dedupeKey: (_d, ev) => ev.id,
}

/** The suppression a bounce asks for, or null. `Inactive` is Postmark's own verdict. */
export function suppressionFor(b: PostmarkBounce): { email: string; reason: 'bounce' | 'complaint'; detail?: string } | null {
  if (b.RecordType === 'SpamComplaint') return { email: b.Email, reason: 'complaint' }
  if (b.RecordType === 'Bounce' && b.Inactive) return { email: b.Email, reason: 'bounce', detail: b.Description }
  return null
}
