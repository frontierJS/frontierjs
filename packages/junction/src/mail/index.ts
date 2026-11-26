// mail/index.ts
// The mail battery — `app.mail`. Owns the IMail interface, the MailBuilder,
// the SMTP client (./smtp.ts — the transport you can always rely on) and a
// minimal Resend adapter. Mail to a person with an account goes through
// @frontierjs/notifications, whose email channel sends through this; an app
// calls `app.mail` itself only for an address that may have no account
// (a reset, a verification, an invitation) — `FJS-D644`.
//
// Rest of framework uses the IMail interface only.

// ─── IMail interface ──────────────────────────────────────────────────────

export interface MailMessage {
  to:          string | string[]
  subject:     string
  html?:       string
  text?:       string
  from?:       string          // overrides config default; 'Name <addr>' or a bare addr, as every address here
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
  /**
   * Inline rather than attached: the HTML draws it as `<img src="cid:chart">`
   * for `cid: 'chart'`, and the reader is offered no file. An email client
   * draws no SVG and Gmail and Outlook refuse a `data:` image, so a chart in a
   * mail is a PNG sent this way or not at all (`FJS-1666`). Needs `html`.
   */
  cid?:      string
}

export interface SendResult {
  /** The provider's own handle — what its delivery webhooks and support name
   *  the email by. Its shape is the adapter's; never a header (`FJS-D684`). */
  id:        string
  /** The Message-ID the message went out under, stated or minted: what a
   *  reply's In-Reply-To and References name. */
  messageId: string
  message:   string
}

export interface IMail {
  send(message: MailMessage):                                           Promise<SendResult>
  batch(messages: MailMessage[]):                                       Promise<SendResult[]>
}

// ─── Mail builder ─────────────────────────────────────────────────────────
// Fluent API — same feel as Total.js mail builder.

import { assertMessageAddresses, assertHeaderValue, assertHeaderName, assertContentId, messageIdFor, SmtpError } from './smtp.ts'

// Re-exported because a test double implementing `IMail` has to accept exactly
// what the real mailer accepts. A double that took a message SMTP would refuse
// is worse than no double: the test passes and the send fails in production
// (`FJS-904`). One owner for the rule, in `smtp.ts`; this is the door to it.
export { assertMessageAddresses, assertHeaderValue, assertHeaderName, assertContentId } from './smtp.ts'

// The message as one RFC 5322 text, for a mailer whose transport takes a whole
// message (Graph's sendMail, SES's SendRawEmail) rather than an SMTP session.
export { toMime } from './smtp.ts'

// Minted in one place, so every `IMail` answers `SendResult.messageId` the
// same way and a stated Message-ID wins under each.
export { messageIdFor } from './smtp.ts'

// The receiving half: the shape a mail vendor's dialect parses to, and the
// reply-tag kit an app's `apply` reads it with (`FJS-D1091`). `assertMailbox`
// goes with it, so a `from` is split into name and address by the one owner
// of the grammar rather than by a regex in every app.
export { assertMailbox } from './smtp.ts'
export { headerOf, replyAddress, splitAddress, readReplyTag, LOCAL_PART_MAX } from './received.ts'
export type { ReceivedMail, ReplyReading } from './received.ts'

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

  /** An image the HTML draws as `<img src="cid:${cid}">`, sent inline. */
  inline(cid: string, filename: string, content: ArrayBuffer | Uint8Array | string, type?: string): this {
    if (!this._msg.attachments) this._msg.attachments = []
    this._msg.attachments.push({ filename, content, type, cid: assertContentId(cid) })
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

// What a battery needs of a credential store, and nothing more. Structural, so
// Conduit's `CredentialResolver` satisfies it with no import in either
// direction, and `{ get: k => process.env[k] }` satisfies it with no Conduit
// at all (`FJS-D219`).
export interface CredentialSource {
  get(ref: string): Promise<string | null | undefined> | string | null | undefined
}

// The key is named, not held: `credentials` + `apiKeyRef` resolve it at send
// time, which is Conduit's convention for a secret. A literal `apiKey` still
// works and keeps the secret in this closure for the life of the process.
export type ResendOptions = {
  from:    string    // default sender
  replyTo?: string
} & (
  | { apiKey: string; credentials?: never; apiKeyRef?: never }
  | { credentials: CredentialSource; apiKeyRef: string; apiKey?: never }
)

export function createResendMailer(opts: ResendOptions): IMail {

  const { from: defaultFrom, replyTo: defaultReplyTo } = opts
  const BASE_URL = 'https://api.resend.com'
  // No retry and no breaker: a send is not idempotent, and a second attempt
  // after a lost response is a second email. An app that needs either routes
  // through Conduit, which owns both (`FJS-659`).
  const REQUEST_TIMEOUT_MS = 30_000

  async function resolveKey(): Promise<string> {
    if (opts.apiKey !== undefined) return opts.apiKey
    const key = await opts.credentials?.get(opts.apiKeyRef!)
    if (!key) throw new Error(`Resend API key: credential "${opts.apiKeyRef}" did not resolve`)
    return key
  }

  async function post(path: string, body: unknown): Promise<unknown> {
    const apiKey = await resolveKey()
    let res: Response
    try {
      res = await fetch(BASE_URL + path, {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type':  'application/json'
        },
        body:   JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
    } catch (e) {
      // Named, because the bare DOMException says "operation timed out" and
      // nothing about which vendor, which is all a log line has to go on.
      if (e instanceof Error && e.name === 'TimeoutError') {
        throw new Error(`Resend API timed out after ${REQUEST_TIMEOUT_MS}ms`)
      }
      throw e
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText })) as { message?: string }
      throw new Error(`Resend API error ${res.status}: ${err.message ?? res.statusText}`)
    }

    return res.json()
  }

  function toResendPayload(msg: MailMessage): { payload: Record<string, unknown>, messageId: string } {

    const from = msg.from ?? defaultFrom
    // Resend's own id is on no header, so a reply could not name it; the
    // Message-ID is minted here and sent. Whether Resend keeps a stated one is
    // unproven against the live API (`FJS-4481`).
    const { header, id: messageId } = messageIdFor({ from, headers: msg.headers })
    const payload: Record<string, unknown> = {
      from,
      to:      Array.isArray(msg.to) ? msg.to : [msg.to],
      subject: msg.subject,
      headers: header ? { ...msg.headers, [header]: messageId } : msg.headers,
    }

    if (msg.html)    payload.html    = msg.html
    if (msg.text)    payload.text    = msg.text
    if (msg.replyTo ?? defaultReplyTo) payload.reply_to = msg.replyTo ?? defaultReplyTo
    if (msg.cc)      payload.cc      = Array.isArray(msg.cc)  ? msg.cc  : [msg.cc]
    if (msg.bcc)     payload.bcc     = Array.isArray(msg.bcc) ? msg.bcc : [msg.bcc]

    if (msg.attachments?.length) {
      payload.attachments = msg.attachments.map(a => ({
        filename: a.filename,
        content:  toBase64(a.content),
        // Resend's own name for it. Without it the image arrived as a file
        // and the HTML's cid: drew nothing (`FJS-1666`).
        ...(a.type !== undefined ? { content_type: a.type } : {}),
        ...(a.cid  !== undefined ? { content_id: assertContentId(a.cid) } : {}),
      }))
    }

    if (msg.tags) {
      payload.tags = Object.entries(msg.tags).map(([name, value]) => ({ name, value }))
    }

    return { payload, messageId }
  }

  return {

    async send(message: MailMessage): Promise<SendResult> {
      const { payload, messageId } = toResendPayload(message)
      const result = await post('/emails', payload) as { id: string }
      return { id: result.id, messageId, message: 'sent' }
    },

    async batch(messages: MailMessage[]): Promise<SendResult[]> {
      const built = messages.map(toResendPayload)
      // Answered in order, one per message, under `data`.
      const { data } = await post('/emails/batch', built.map(b => b.payload)) as { data: { id: string }[] }
      return data.map((r, i) => ({ id: r.id, messageId: built[i].messageId, message: 'sent' }))
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
  /** Per-read deadline for the SMTP conversation. Default 30s. */
  timeoutMs?: number
}

/**
 * The parts of a message that become header lines but are not addresses.
 *
 * Graded HERE as well as in the transport, which is what the address rules
 * already do: at the adapter a mistake is cheapest to attribute, and — the
 * reason this is not merely tidy — a refusal raised while building the MIME
 * body happens with a socket already open and a session mid-transaction, where
 * it read as a hang rather than as a refusal.
 */
function assertMessageHeaders(msg: MailMessage): void {
  for (const [k, v] of Object.entries(msg.headers ?? {})) {
    assertHeaderName(k)
    assertHeaderValue(v, `headers.${k}`)
  }
  for (const a of msg.attachments ?? []) {
    assertHeaderValue(a.filename, 'attachment.filename')
    if (a.type !== undefined) assertHeaderValue(a.type, 'attachment.type')
    if (a.cid  !== undefined) assertContentId(a.cid)
  }
}

export function createSmtpMailer(opts: SmtpMailerOptions): IMail {
  const { host, port = 587, user, pass, from: defaultFrom, tls, replyTo: defaultReplyTo, timeoutMs } = opts

  return {
    async send(message: MailMessage): Promise<SendResult> {
      const { sendMail } = await import('./smtp.ts')
      // The DEFAULTS are what will be sent, so they are what is graded — a
      // configured `from` reaches the wire exactly as a stated one does.
      assertMessageAddresses({ ...message, from: message.from ?? defaultFrom, replyTo: message.replyTo ?? defaultReplyTo })
      assertMessageHeaders(message)
      const id = await sendMail(
        { host, port, user, pass, tls, timeoutMs },
        {
          from:     message.from    ?? defaultFrom,
          to:       message.to,
          subject:  message.subject,
          html:     message.html,
          text:     message.text,
          replyTo:  message.replyTo ?? defaultReplyTo,
          // The four the adapter used to leave out. They were declared on
          // `MailMessage`, validated on the way in, and then dropped between
          // here and the wire — so `sent` meant "sent, minus these" and the
          // Resend adapter beside this one mapped every one of them.
          cc:          message.cc,
          bcc:         message.bcc,
          headers:     message.headers,
          attachments: message.attachments,
        }
      )
      // The Message-ID is the only handle an SMTP send has.
      return { id, messageId: id, message: 'sent' }
    },

    async batch(messages: MailMessage[]): Promise<SendResult[]> {
      // One SMTP session for the whole batch — previously this fired N
      // parallel send() calls, each paying a full TCP/TLS/EHLO/AUTH
      // handshake (and looking like a connection flood to the server).
      const { sendMailBatch } = await import('./smtp.ts')
      const results = await sendMailBatch(
        { host, port, user, pass, tls, timeoutMs },
        messages.map(m => {
          assertMessageAddresses({ ...m, from: m.from ?? defaultFrom, replyTo: m.replyTo ?? defaultReplyTo })
          assertMessageHeaders(m)
          return {
          from:    m.from    ?? defaultFrom,
          to:      m.to,
          subject: m.subject,
          html:    m.html,
          text:    m.text,
          replyTo: m.replyTo ?? defaultReplyTo,
          cc:          m.cc,
          bcc:         m.bcc,
          headers:     m.headers,
          attachments: m.attachments,
          }
        })
      )
      return results.map(r => r.ok
        ? { id: r.id!, messageId: r.id!, message: 'sent' }
        : { id: '', messageId: '', message: `failed: ${r.error}` })
    }
  }
}

// ─── Mailer plugin ────────────────────────────────────────────────────────
// Registers a mailer on app.mail so it's accessible everywhere.
//
import { warnEffectInDrain } from '../core/context.ts'

// Usage:
//   import { mail, createResendMailer } from '@frontierjs/junction/mail'
//
//   app.configure(mail({ mailer: createResendMailer({
//     credentials: { get: ref => process.env[ref] },   // or a Conduit resolver
//     apiKeyRef:   'RESEND_API_KEY',
//     from:        'Elite Lawn Care <noreply@elitelawncare.com>',
//   }) }))
//
//   // Then anywhere in hooks or services:
//   await ctx.app.mail?.send({ to, subject, html })

/**
 * What no mailer may be handed, whichever one `mail()` wraps: an address that
 * is not one, a line break in a subject, a bad content id, an inline image with
 * no HTML to draw it. A mailer an app wrote (a stub, a capture double, a
 * connector's adapter) graded none of these, and a CRLF in a `cc` is a header
 * of the sender's choosing once the provider writes the message out.
 *
 * `from` is graded only if stated: each adapter fills in its own default, and
 * grades that one itself.
 */
function assertMessageAcceptable(msg: MailMessage): void {
  assertMessageAddresses(msg)
  const inline = (msg.attachments ?? []).filter(a => a.cid !== undefined)
  for (const a of inline) assertContentId(a.cid!)
  if (inline.length && !msg.html)
    throw new SmtpError('Mail: an inline attachment (cid) needs an html body to draw it — a plain-text body has nowhere to put an image')
}

export function mail({ mailer }: { mailer: IMail }): import('../core/app.ts').Plugin {
  return {
    name: 'mailer',
    register(app: import('../core/app.ts').App): void {
      // Wrapped rather than read by each adapter: the warning is about where the
      // send runs, which no adapter knows.
      // Object.create keeps a class-instance mailer's own methods reachable.
      const wrapped = Object.assign(Object.create(mailer), {
        send:  async (m: MailMessage)   => { warnEffectInDrain('app.mail.send()');  assertMessageAcceptable(m); return mailer.send(m) },
        batch: async (ms: MailMessage[]) => { warnEffectInDrain('app.mail.batch()'); ms.forEach(assertMessageAcceptable); return mailer.batch(ms) },
      })
      if (typeof app.own === 'function') app.own('mail', wrapped)
      else app.mail = wrapped
    }
  }
}

// ─── Dev and test mailers ─────────────────────────────────────────────────
// Two `IMail`s that send nothing. They grade what a real mailer grades — the
// address and header rules, a cid with no html, a `from` that is not a
// mailbox — so a message either accepts is one SMTP would accept too. A double
// more permissive than production passes in a test and fails in the field
// (`FJS-904`). A batch is graded whole before any of it is kept or printed,
// so a bad message leaves nothing behind, as a rejected batch would.

export interface DevMailerOptions {
  /** Stands in for the adapter's configured sender. Default `mail@localhost`. */
  from?: string
}

export interface CaptureMailerOptions extends DevMailerOptions {
  /** Also print each message as `createLogMailer` does. A function takes the
   *  text instead of `console.log`. */
  log?: boolean | ((text: string) => void)
}

export interface LogMailerOptions extends DevMailerOptions {
  /** Where the text goes. Default `console.log`. */
  write?: (text: string) => void
}

/** What the capture mailer kept: the message as handed in, with the sender and
 *  Message-ID it would have gone out under and when it was handed in. */
export type SentMail = MailMessage & { from: string, messageId: string, sentAt: string }

export interface CaptureMailer extends IMail {
  /** Every message sent since the last `clear()`, oldest first. Live: read it
   *  after the send, not before. */
  readonly sent: readonly SentMail[]
  /** The sent messages with `address` among their `to`. */
  to(address: string): SentMail[]
  clear(): void
}

function stampDevMessage(message: MailMessage, defaultFrom: string): { from: string, messageId: string } {
  const from = message.from ?? defaultFrom
  assertMessageAcceptable({ ...message, from })
  assertMessageHeaders(message)
  return { from, messageId: messageIdFor({ from, headers: message.headers }).id }
}

// One line a person can click through from a terminal, then the text body.
// `[mail] -> to . subject` is what a drive that reads the API's log splits on.
function transcribe(message: MailMessage): string {
  const to       = Array.isArray(message.to) ? message.to.join(', ') : message.to
  const attached = (message.attachments ?? []).map(a => `${a.filename}${a.type ? ` (${a.type})` : ''}`)
  return `[mail] -> ${to} . ${message.subject}\n${message.text ?? ''}` +
    (attached.length ? `\n[attached] ${attached.join(', ')}` : '')
}

/**
 * A mailer that keeps what it is handed, for a test or a drive to read:
 * `mailer.sent`, `mailer.to(address)`, `mailer.clear()`.
 */
export function createCaptureMailer(opts: CaptureMailerOptions = {}): CaptureMailer {
  const { from: defaultFrom = 'mail@localhost', log } = opts
  const write = typeof log === 'function' ? log : log ? (t: string) => console.log(t) : null
  const sent: SentMail[] = []

  const stamp = (m: MailMessage) => stampDevMessage(m, defaultFrom)
  const keep = (m: MailMessage, stamped: { from: string, messageId: string }): SendResult => {
    sent.push({ ...m, ...stamped, sentAt: new Date().toISOString() })
    write?.(transcribe(m))
    return { id: `capture-${sent.length}`, messageId: stamped.messageId, message: 'captured' }
  }

  return {
    sent,
    to: address => sent.filter(m => (Array.isArray(m.to) ? m.to : [m.to]).includes(address)),
    clear: () => { sent.length = 0 },
    async send(message) { return keep(message, stamp(message)) },
    async batch(messages) {
      const stamped = messages.map(stamp)
      return messages.map((m, i) => keep(m, stamped[i]))
    },
  }
}

/** A mailer that prints each message instead of sending it, for dev with no
 *  provider configured. */
export function createLogMailer(opts: LogMailerOptions = {}): IMail {
  const { from: defaultFrom = 'mail@localhost', write = (t: string) => console.log(t) } = opts
  let seq = 0
  const print = (m: MailMessage, stamped: { messageId: string }): SendResult => {
    write(transcribe(m))
    return { id: `log-${++seq}`, messageId: stamped.messageId, message: 'logged' }
  }
  return {
    async send(message) { return print(message, stampDevMessage(message, defaultFrom)) },
    async batch(messages) {
      const stamped = messages.map(m => stampDevMessage(m, defaultFrom))
      return messages.map((m, i) => print(m, stamped[i]))
    },
  }
}

// The battery fills its own slot (`FJS-D640`); augment, never redeclare `App.mail`.
declare module '../core/app.ts' {
  interface AppMail extends IMail {}
}
