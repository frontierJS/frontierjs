// mail/index.ts
// Junction's INTERNAL mail system — always available, intended for
// notification / system email that the app itself sends (password resets,
// alerts, receipts). Owns the IMail interface, the MailBuilder, and the
// SMTP client (./smtp.ts — the transport you can always rely on), plus a
// minimal Resend adapter for when system mail should go through Resend.
//
// Division of responsibility:
//   src/mail          → internal/system mail (this module). Base layer.
//   src/plugins/email → 3rd-party provider integrations and higher-level
//                       system/campaign email features. Builds ON TOP of
//                       this module's SMTP transport (imports ./smtp.ts).
//
// Rest of framework uses the IMail interface only.

// ─── IMail interface ──────────────────────────────────────────────────────

export interface MailMessage {
  to:          string | string[]
  subject:     string
  html?:       string
  text?:       string
  from?:       string          // overrides config default
  replyTo?:    string
  cc?:         string | string[]
  bcc?:        string | string[]
  attachments?: MailAttachment[]
  headers?:    Record<string, string>
  tags?:       Record<string, string>
}

export interface MailAttachment {
  filename:  string
  content:   ArrayBuffer | Uint8Array | string    // base64 string or buffer
  type?:     string                               // MIME type
}

export interface SendResult {
  id:      string
  message: string
}

export interface IMail {
  send(message: MailMessage):                                           Promise<SendResult>
  batch(messages: MailMessage[]):                                       Promise<SendResult[]>
}

// ─── Mail builder ─────────────────────────────────────────────────────────
// Fluent API — same feel as Total.js mail builder.

import { assertMessageAddresses, assertHeaderValue } from './smtp.ts'

export function createMessage(subject: string, html?: string): MailBuilder {
  return new MailBuilder(subject, html)
}

export class MailBuilder {

  private _msg: MailMessage

  constructor(subject: string, html?: string) {
    this._msg = { to: [], subject, html }
  }

  to(address: string | string[]): this {
    this._msg.to = address
    return this
  }

  from(address: string): this {
    this._msg.from = address
    return this
  }

  replyTo(address: string): this {
    this._msg.replyTo = address
    return this
  }

  cc(address: string | string[]): this {
    this._msg.cc = address
    return this
  }

  bcc(address: string | string[]): this {
    this._msg.bcc = address
    return this
  }

  body(html: string): this {
    this._msg.html = html
    return this
  }

  text(plain: string): this {
    this._msg.text = plain
    return this
  }

  attach(filename: string, content: ArrayBuffer | Uint8Array | string, type?: string): this {
    if (!this._msg.attachments) this._msg.attachments = []
    this._msg.attachments.push({ filename, content, type })
    return this
  }

  tag(key: string, value: string): this {
    if (!this._msg.tags) this._msg.tags = {}
    this._msg.tags[key] = value
    return this
  }

  header(key: string, value: string): this {
    if (!this._msg.headers) this._msg.headers = {}
    this._msg.headers[key] = value
    return this
  }

  build(): MailMessage {
    if (!this._msg.to || (Array.isArray(this._msg.to) && !this._msg.to.length))
      throw new Error('Mail: at least one recipient required')
    // Refused where a mistake is cheapest to attribute, and again at the wire.
    // SMTP is line-oriented, so a CRLF in any of these is a command or a header
    // of the caller's choosing rather than a bad value (`FJS-677`).
    assertMessageAddresses(this._msg)
    for (const [k, v] of Object.entries(this._msg.headers ?? {})) assertHeaderValue(v, `headers.${k}`)
    if (!this._msg.subject)
      throw new Error('Mail: subject is required')
    if (!this._msg.html && !this._msg.text)
      throw new Error('Mail: html or text body is required')
    return this._msg
  }

  async send(mailer: IMail): Promise<SendResult> {
    return mailer.send(this.build())
  }
}

// ─── Resend adapter ───────────────────────────────────────────────────────
// ONLY this file imports from the Resend SDK.

export interface ResendOptions {
  apiKey:  string
  from:    string    // default sender
  replyTo?: string
}

export function createResendMailer(opts: ResendOptions): IMail {

  const { apiKey, from: defaultFrom, replyTo: defaultReplyTo } = opts
  const BASE_URL = 'https://api.resend.com'

  async function post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(BASE_URL + path, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify(body)
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText })) as { message?: string }
      throw new Error(`Resend API error ${res.status}: ${err.message ?? res.statusText}`)
    }

    return res.json()
  }

  function toResendPayload(msg: MailMessage): Record<string, unknown> {

    const payload: Record<string, unknown> = {
      from:    msg.from    ?? defaultFrom,
      to:      Array.isArray(msg.to) ? msg.to : [msg.to],
      subject: msg.subject,
    }

    if (msg.html)    payload.html    = msg.html
    if (msg.text)    payload.text    = msg.text
    if (msg.replyTo ?? defaultReplyTo) payload.reply_to = msg.replyTo ?? defaultReplyTo
    if (msg.cc)      payload.cc      = Array.isArray(msg.cc)  ? msg.cc  : [msg.cc]
    if (msg.bcc)     payload.bcc     = Array.isArray(msg.bcc) ? msg.bcc : [msg.bcc]
    if (msg.headers) payload.headers = msg.headers

    if (msg.attachments?.length) {
      payload.attachments = msg.attachments.map(a => ({
        filename: a.filename,
        content:  toBase64(a.content),
      }))
    }

    if (msg.tags) {
      payload.tags = Object.entries(msg.tags).map(([name, value]) => ({ name, value }))
    }

    return payload
  }

  return {

    async send(message: MailMessage): Promise<SendResult> {
      const result = await post('/emails', toResendPayload(message)) as { id: string }
      return { id: result.id, message: 'sent' }
    },

    async batch(messages: MailMessage[]): Promise<SendResult[]> {
      const results = await post('/emails/batch', messages.map(toResendPayload)) as { id: string }[]
      return results.map(r => ({ id: r.id, message: 'sent' }))
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function toBase64(content: ArrayBuffer | Uint8Array | string): string {
  if (typeof content === 'string') return content
  const arr = content instanceof ArrayBuffer ? new Uint8Array(content) : content
  return Buffer.from(arr).toString('base64')
}

// ─── SMTP adapter ─────────────────────────────────────────────────────────
// Wraps the Bun-native SMTP client from email/system/smtp.ts.
// Opens a fresh connection per send — stateless and safe for low-volume use.
// For high-volume, layer a connection pool on top.

export interface SmtpMailerOptions {
  host:     string
  port?:    number       // default: 587
  user:     string
  pass:     string
  from:     string       // default sender address
  tls?:     boolean      // auto-true on port 465
  replyTo?: string
}

export function createSmtpMailer(opts: SmtpMailerOptions): IMail {
  const { host, port = 587, user, pass, from: defaultFrom, tls, replyTo: defaultReplyTo } = opts

  return {
    async send(message: MailMessage): Promise<SendResult> {
      const { sendMail } = await import('./smtp.ts')
      // The DEFAULTS are what will be sent, so they are what is graded — a
      // configured `from` reaches the wire exactly as a stated one does.
      assertMessageAddresses({ ...message, from: message.from ?? defaultFrom, replyTo: message.replyTo ?? defaultReplyTo })
      await sendMail(
        { host, port, user, pass, tls },
        {
          from:     message.from    ?? defaultFrom,
          to:       message.to,
          subject:  message.subject,
          html:     message.html,
          text:     message.text,
          replyTo:  message.replyTo ?? defaultReplyTo,
        }
      )
      return { id: crypto.randomUUID(), message: 'sent' }
    },

    async batch(messages: MailMessage[]): Promise<SendResult[]> {
      // One SMTP session for the whole batch — previously this fired N
      // parallel send() calls, each paying a full TCP/TLS/EHLO/AUTH
      // handshake (and looking like a connection flood to the server).
      const { sendMailBatch } = await import('./smtp.ts')
      const results = await sendMailBatch(
        { host, port, user, pass, tls },
        messages.map(m => {
          assertMessageAddresses({ ...m, from: m.from ?? defaultFrom, replyTo: m.replyTo ?? defaultReplyTo })
          return {
          from:    m.from    ?? defaultFrom,
          to:      m.to,
          subject: m.subject,
          html:    m.html,
          text:    m.text,
          replyTo: m.replyTo ?? defaultReplyTo,
          }
        })
      )
      return results.map(r => r.ok
        ? { id: crypto.randomUUID(), message: 'sent' }
        : { id: '', message: `failed: ${r.error}` })
    }
  }
}

// ─── Mailer plugin ────────────────────────────────────────────────────────
// Registers a mailer on app.mail so it's accessible everywhere.
//
// Usage:
//   import { mailerPlugin, createResendMailer } from '@frontierjs/junction'
//
//   app.configure(mailerPlugin(createResendMailer({
//     apiKey: process.env.RESEND_API_KEY!,
//     from:   'Elite Lawn Care <noreply@elitelawncare.com>',
//   })))
//
//   // Then anywhere in hooks or services:
//   await ctx.app.mail?.send({ to, subject, html })

export function mailerPlugin(mailer: IMail): import('../core/app.ts').Plugin {
  return {
    name: 'mailer',
    register(app: import('../core/app.ts').App): void {
      app.mail = mailer   // typed App field — no cast
    }
  }
}
