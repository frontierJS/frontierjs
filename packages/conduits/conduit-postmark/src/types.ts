// src/types.ts — Postmark's shapes, for the calls this connector makes.

/** Structurally junction's `MailMessage`; declared here so this package imports nothing from junction. */
export interface MailMessage {
  to: string | string[]; subject: string; html?: string; text?: string; from?: string; replyTo?: string
  cc?: string | string[]; bcc?: string | string[]; attachments?: MailAttachment[]; headers?: Record<string, string>; tags?: Record<string, string>
}
export interface MailAttachment { filename: string; content: ArrayBuffer | Uint8Array | string; type?: string; cid?: string }
export interface SendResult { id: string; message: string }

/** Postmark's PascalCase. `Tag` is ONE string; `Metadata` is the map. */
export interface PostmarkEmail {
  From: string; To: string; Subject: string; HtmlBody?: string; TextBody?: string; ReplyTo?: string; Cc?: string; Bcc?: string
  Tag?: string; Metadata?: Record<string, string>; Headers?: { Name: string; Value: string }[]
  Attachments?: { Name: string; Content: string; ContentType: string; ContentID?: string }[]
  MessageStream?: string
}
export interface PostmarkSendResponse { To: string; SubmittedAt: string; MessageID: string; ErrorCode: number; Message: string }
export interface PostmarkErrorBody { ErrorCode?: number; Message?: string }

/** The inbound webhook: a parsed message, which is the half `inbound-email.md` wants. `OriginalRecipient` is the envelope address, where a reply tag rides. */
export interface PostmarkInbound {
  MessageID: string; From: string; FromName?: string; FromFull?: PostmarkFull; To: string; ToFull?: PostmarkFull[]; Cc?: string; CcFull?: PostmarkFull[]
  OriginalRecipient?: string; Subject: string; Date: string
  TextBody?: string; HtmlBody?: string; StrippedTextReply?: string; MailboxHash?: string
  Headers?: { Name: string; Value: string }[]
  Attachments?: { Name: string; Content: string; ContentType: string; ContentLength: number; ContentID?: string }[]
}
export interface PostmarkFull { Email: string; Name?: string; MailboxHash?: string }

/**
 * Structurally junction's `ReceivedMail` (`@frontierjs/junction/mail`, `FJS-D1091`): a `MailMessage` read the
 * other way, `from` required, Message-ID and In-Reply-To in `headers`, and the envelope `recipient`.
 */
export interface ReceivedMail extends Omit<MailMessage, 'from' | 'headers'> { from: string; headers: Record<string, string>; recipient: string }
/** What `postmarkMailDialect` parses a delivery to: conduit's event envelope around one mail. */
export interface PostmarkMailEvent { id: string; type: 'mail'; payload: ReceivedMail }
/** Bounce and spam-complaint webhooks. */
export interface PostmarkBounce { RecordType: 'Bounce' | 'SpamComplaint'; ID: number; Type: string; TypeCode: number; Email: string; MessageID: string; Description?: string; Inactive: boolean }
