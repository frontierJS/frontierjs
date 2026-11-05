// src/types.ts — SendGrid's v3 shapes, for the calls this connector makes.

/** Structurally junction's `MailMessage`; declared here so this package imports nothing from junction. */
export interface MailMessage {
  to: string | string[]; subject: string; html?: string; text?: string; from?: string; replyTo?: string
  cc?: string | string[]; bcc?: string | string[]; attachments?: MailAttachment[]; headers?: Record<string, string>; tags?: Record<string, string>
}
export interface MailAttachment { filename: string; content: ArrayBuffer | Uint8Array | string; type?: string; cid?: string }
export interface SendResult { id: string; message: string }
export interface IMail { send(message: MailMessage): Promise<SendResult>; batch(messages: MailMessage[]): Promise<SendResult[]> }

export interface SendgridAddress { email: string; name?: string }

/**
 * `POST /v3/mail/send`. `custom_args` come back on every event about the mail,
 * which is how a webhook finds its row before it knows the provider's id.
 * `mail_settings.sandbox_mode` validates and bills nothing; SendGrid still
 * answers 400 for a bad sender under it, which is what makes it a test mode.
 */
export interface SendgridPayload {
  personalizations: { to: SendgridAddress[]; cc?: SendgridAddress[]; bcc?: SendgridAddress[]; custom_args?: Record<string, string> }[]
  from:          SendgridAddress
  reply_to?:     SendgridAddress
  subject:       string
  content:       { type: 'text/plain' | 'text/html'; value: string }[]
  attachments?:  { content: string; filename: string; type?: string; disposition?: 'attachment' | 'inline'; content_id?: string }[]
  headers?:      Record<string, string>
  categories?:   string[]
  custom_args?:  Record<string, string>
  mail_settings?: { sandbox_mode?: { enable: boolean } }
}

/** A 4xx body. `field` is a JSON pointer into the payload; a 401 carries the same shape. */
export interface SendgridErrorBody { errors?: { message: string; field?: string | null; help?: string | null }[] }

export type SendgridEventType = 'processed' | 'delivered' | 'deferred' | 'bounce' | 'dropped' | 'open' | 'click' | 'spamreport' | 'unsubscribe' | (string & {})

/** One entry of the event webhook's JSON array. `custom_args` are spread flat onto the event, so `messageId` is a top-level key. */
export interface SendgridEvent {
  event:          SendgridEventType
  email:          string
  timestamp:      number
  sg_event_id:    string
  sg_message_id?: string
  reason?:        string
  response?:      string
  messageId?:     string
  [customArg: string]: unknown
}

/** `POST /v3/whitelabel/domains` with `automatic_security` answers the three CNAMEs under `dns`. */
export interface SendgridDomain {
  id:        number
  domain:    string
  subdomain: string
  valid:     boolean
  dns:       Record<string, { valid: boolean; type: string; host: string; data: string }>
}

/** A CNAME in the shape a DNS writer takes. `proxied: false` is part of the record: a proxied CNAME never resolves for DKIM. */
export interface DnsRecord { type: 'CNAME'; name: string; content: string; proxied: false }
