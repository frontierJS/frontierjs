// @frontierjs/conduit-resend — Resend over conduit.
//
// Extracted from `packages/junction/src/mail/index.ts` § Resend adapter, which
// is the FJS-D153 inversion in the tree: a vendor inside a battery, dialing out
// with its own `fetch`, no retry and no breaker. Here the call goes through a
// declared target, and `createResendMailer(send)` answers junction's `IMail`
// by structure so `mailerPlugin(createResendMailer(...))` needs no adapter in
// junction at all.
//
// A send is NOT idempotent and Resend honors no idempotency header: a retry
// after a lost response is a second email. So every send is unkeyed and
// unreplayable, and a timeout comes back `indeterminate` — the caller decides.

import type { ConduitRequest, ConduitResult, TargetDescriptor } from '@frontierjs/conduit'
import { translate, type ResendFailure } from './errors.ts'
import type { MailMessage, ResendEmail, SendResult } from './types.ts'

export * from './types.ts'
export * from './errors.ts'
export * from './verify.ts'

export const RESEND_TARGET  = 'provider:resend'
export const RESEND_ADDRESS = 'https://api.resend.com'

export type Send = <T>(req: Omit<ConduitRequest, 'target'>) => Promise<ConduitResult<T>>
export function bindSend(conduit: { send<T>(req: ConduitRequest): Promise<ConduitResult<T>> }, target = RESEND_TARGET): Send {
  return req => conduit.send({ target, ...req })
}

export function resendTarget(opts: { ref?: string; address?: string; id?: string } = {}): TargetDescriptor {
  return {
    id:            opts.id ?? RESEND_TARGET,
    kind:          'provider',
    protocol:      'http',
    address:       opts.address ?? RESEND_ADDRESS,
    auth:          { type: 'bearer', ref: opts.ref ?? 'RESEND_API_KEY' },
    registered_at: Date.now(),
    last_seen_at:  null,
  }
}

const list = (v: string | string[] | undefined) => v === undefined ? undefined : Array.isArray(v) ? v : [v]
const toBase64 = (c: ArrayBuffer | Uint8Array | string) =>
  typeof c === 'string' ? c : Buffer.from(c instanceof ArrayBuffer ? new Uint8Array(c) : c).toString('base64')

/** A CRLF in an address or header is a header of the sender's choosing (FJS-677). */
function assertNoCrlf(value: string, what: string) {
  if (/[\r\n]/.test(value)) throw new Error(`resend: ${what} contains a line break`)
}

export function toResendPayload(msg: MailMessage, defaults: { from: string; replyTo?: string }): ResendEmail {
  const from = msg.from ?? defaults.from
  for (const [what, v] of Object.entries({ from, subject: msg.subject, replyTo: msg.replyTo ?? '' })) assertNoCrlf(v, what)
  for (const a of list(msg.to) ?? []) assertNoCrlf(a, 'to')
  for (const [k, v] of Object.entries(msg.headers ?? {})) { assertNoCrlf(k, 'header name'); assertNoCrlf(v, `headers.${k}`) }
  const to = list(msg.to)
  if (!to?.length) throw new Error('resend: at least one recipient is required')
  if (!msg.html && !msg.text) throw new Error('resend: html or text body is required')
  return {
    from, to, subject: msg.subject,
    ...(msg.html ? { html: msg.html } : {}),
    ...(msg.text ? { text: msg.text } : {}),
    ...((msg.replyTo ?? defaults.replyTo) ? { reply_to: msg.replyTo ?? defaults.replyTo } : {}),
    ...(msg.cc  ? { cc:  list(msg.cc) }  : {}),
    ...(msg.bcc ? { bcc: list(msg.bcc) } : {}),
    ...(msg.headers ? { headers: msg.headers } : {}),
    ...(msg.tags ? { tags: Object.entries(msg.tags).map(([name, value]) => ({ name, value })) } : {}),
    ...(msg.attachments?.length ? { attachments: msg.attachments.map(a => ({
      filename: a.filename, content: toBase64(a.content),
      // Resend's own names. Without `content_id` an inline image arrives as a
      // file and the HTML's cid: draws nothing (FJS-1666).
      ...(a.type !== undefined ? { content_type: a.type } : {}),
      ...(a.cid  !== undefined ? { content_id:   a.cid }  : {}),
    })) } : {}),
  }
}

export async function sendEmail(send: Send, email: ResendEmail): Promise<{ id?: string; error?: ResendFailure }> {
  const r = await send<{ id: string }>({ method: 'POST', path: '/emails', body: email })
  if (r.error) return { error: translate(r.error) }
  return { id: r.data.id }
}

export async function sendBatch(send: Send, emails: ResendEmail[]): Promise<{ ids?: string[]; error?: ResendFailure }> {
  const r = await send<{ data: { id: string }[] }>({ method: 'POST', path: '/emails/batch', body: emails })
  if (r.error) return { error: translate(r.error) }
  return { ids: r.data.data.map(d => d.id) }
}

/** Junction's `IMail`, by structure. A failure THROWS, as the battery's did,
 *  with `retryable` and `indeterminate` copied onto the error for a job to read. */
export function createResendMailer(send: Send, defaults: { from: string; replyTo?: string }) {
  const raise = (f: ResendFailure): never => {
    const err = Object.assign(new Error(`Resend: ${f.kind} — ${f.message}`), { kind: f.kind, retryable: f.retryable })
    throw err
  }
  return {
    async send(message: MailMessage): Promise<SendResult> {
      const r = await sendEmail(send, toResendPayload(message, defaults))
      if (r.error) raise(r.error)
      return { id: r.id!, message: 'sent' }
    },
    async batch(messages: MailMessage[]): Promise<SendResult[]> {
      const r = await sendBatch(send, messages.map(m => toResendPayload(m, defaults)))
      if (r.error) raise(r.error)
      return r.ids!.map(id => ({ id, message: 'sent' }))
    },
  }
}
