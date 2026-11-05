// src/types.ts — Mailgun's shapes, for the calls this connector makes.

/** Structurally junction's `MailMessage`; declared here so this package imports nothing from junction. */
export interface MailMessage {
  to: string | string[]; subject: string; html?: string; text?: string; from?: string; replyTo?: string
  cc?: string | string[]; bcc?: string | string[]; attachments?: MailAttachment[]; headers?: Record<string, string>; tags?: Record<string, string>
}
export interface MailAttachment { filename: string; content: ArrayBuffer | Uint8Array | string; type?: string; cid?: string }
export interface SendResult { id: string; message: string }
export interface IMail { send(message: MailMessage): Promise<SendResult>; batch(messages: MailMessage[]): Promise<SendResult[]> }

/**
 * `POST /v3/{domain}/messages`, form-encoded. `h:Name` is a header, `o:tag`
 * a tag, `v:key` a user variable that comes back on every event about the
 * mail. One `o:tag`, because conduit's form encoder writes an array as
 * `o:tag[0]` and Mailgun reads repeated keys; the rest of `tags` rides as
 * `v:` variables, as Postmark's dialect puts them in `Metadata`.
 */
export type MailgunSendForm = Record<string, string>
/** A 200: `id` is the Message-ID Mailgun stamped, angle brackets included. */
export interface MailgunSendResponse { id: string; message: string }
/** A 4xx body; Mailgun's 401 is the bare word `Forbidden` and not this. */
export interface MailgunErrorBody { message?: string }

/**
 * What a route's `forward("https://…/mime")` posts, as form fields. `sender`
 * is the envelope MAIL FROM and `recipient` the envelope RCPT TO — the address
 * a reply tag rides, which may differ from every header. `body-mime` is the
 * whole RFC 5322 message; `from` and `subject` repeat two of its headers.
 * `timestamp`, `token` and `signature` are the webhook signature, over
 * `timestamp + token` and no byte of the rest.
 */
export interface MailgunForward {
  recipient?: string; sender?: string; from?: string; subject?: string
  timestamp?: string; token?: string; signature?: string
  'body-mime'?: string
}

/**
 * Structurally junction's `ReceivedMail` (`@frontierjs/junction/mail`, `FJS-D1091`): a `MailMessage` read the
 * other way, `from` required, Message-ID and In-Reply-To in `headers`, and the envelope `recipient`.
 */
export interface ReceivedMail extends Omit<MailMessage, 'from' | 'headers'> { from: string; headers: Record<string, string>; recipient: string }
/** What `mailgunMailDialect` parses a delivery to. `id` is the mail's Message-ID, or `sha256:…` of its bytes when it has none. */
export interface MailgunMailEvent { id: string; type: 'mail'; payload: ReceivedMail }

/** `GET /v3/{domain}/events` — one item, the fields the resolving read (C6) reads. `message-id` has no angle brackets. */
export interface MailgunEvent {
  id: string; event: string; timestamp: number; recipient?: string; tags?: string[]
  message?: { headers?: { 'message-id'?: string; to?: string; from?: string; subject?: string } }
  'user-variables'?: Record<string, string>
}
export interface MailgunEventsPage { items: MailgunEvent[]; paging?: Record<string, string> }
