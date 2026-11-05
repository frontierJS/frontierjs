// src/types.ts — Resend's shapes, for the calls this connector makes.

/** The message an app hands over. Structurally junction's `MailMessage`, so
 *  `app.mail` callers need no change; declared here so this package imports
 *  nothing from junction. */
export interface MailMessage {
  to:           string | string[]
  subject:      string
  html?:        string
  text?:        string
  from?:        string
  replyTo?:     string
  cc?:          string | string[]
  bcc?:         string | string[]
  attachments?: MailAttachment[]
  headers?:     Record<string, string>
  tags?:        Record<string, string>
}

export interface MailAttachment {
  filename: string
  content:  ArrayBuffer | Uint8Array | string
  type?:    string
  cid?:     string
}

export interface SendResult { id: string; message: string }

/** What Resend reads. `reply_to`, `content_type`, `content_id` are its spellings. */
export interface ResendEmail {
  from:         string
  to:           string[]
  subject:      string
  html?:        string
  text?:        string
  reply_to?:    string
  cc?:          string[]
  bcc?:         string[]
  headers?:     Record<string, string>
  tags?:        { name: string; value: string }[]
  attachments?: { filename: string; content: string; content_type?: string; content_id?: string }[]
}

export interface ResendErrorBody { statusCode?: number; name?: string; message?: string }

/** The events a suppression list is written from. */
export type ResendEventType = 'email.sent' | 'email.delivered' | 'email.bounced' | 'email.complained' | 'email.delivery_delayed' | (string & {})

export interface ResendEvent {
  type:       ResendEventType
  created_at: string
  data:       { email_id: string; to: string[]; from: string; subject: string; bounce?: { type?: string; subType?: string; message?: string } }
}
