// ─── Channel names ────────────────────────────────────────────────────────────

export type BuiltInChannel = 'inApp' | 'email' | 'sms'
export type Channel        = BuiltInChannel | string   // open for custom drivers

// ─── InApp message ────────────────────────────────────────────────────────────

export interface InAppAction {
  label: string
  url:   string
}

export interface InAppMessage {
  title?:       string
  body?:        string
  action?:      InAppAction
  contextType?: string
  contextId?:   number | string | null
  data?:        Record<string, unknown>
}

// ─── Mail message (mirrors @frontierjs/junction mailer shape) ─────────────────

export interface MailLine {
  type:  'greeting' | 'line' | 'action'
  text?: string
  label?: string
  url?:   string
}

export interface MailMessage {
  subject:  string
  lines:    MailLine[]
  to?:      string    // optional override — defaults to user.email

  /**
   * A rendered body, when the builder's lines are not enough.
   *
   * `lines` is a deliberately small authoring vocabulary — greeting, paragraph,
   * button — and it is the right one for most system mail. It cannot express a
   * receipt with a table of items, which is exactly what a transactional email
   * usually is, and it cannot use `@frontierjs/email-kit` at all: that renders a
   * `.mesa` template to Outlook-safe table HTML, and there was nowhere to put
   * the result.
   *
   * Set either and the driver uses it for that field; whichever is absent is
   * still rendered from `lines`, so a template can supply HTML and let the
   * builder write the plain-text alternative.
   */
  html?:    string
  text?:    string
}

// ─── SMS message ──────────────────────────────────────────────────────────────

export interface SmsMessage {
  body: string
  to?:  string        // optional override — defaults to user.phone
}

// ─── Stored notification record (mirrors schema.lite model) ──────────────────

export interface NotificationRecord {
  id:          number
  userId:      number | string
  type:        string
  data:        Record<string, unknown>
  contextType: string | null
  contextId:   number | string | null
  readAt:      string | null
  createdAt:   string
}

// ─── Custom driver interface ──────────────────────────────────────────────────

export interface NotificationDriver {
  channel: string
  send(user: User, message: unknown, app: App): Promise<void>
}

// ─── Minimal user shape — app supplies a richer type ─────────────────────────

export interface User {
  id:      number | string
  email?:  string
  phone?:  string
  [key: string]: unknown
}

// ─── Minimal App interface — only what notify() needs ────────────────────────

/**
 * The wire shape junction's IMail actually accepts. Deliberately NOT
 * `MailMessage & { to }` — MailMessage is this package's *authoring* shape
 * (`lines`), which no mailer understands. The email driver renders one into
 * the other; stating both here is what stopped that mismatch from being
 * invisible. Keep in sync with junction's `MailMessage` in `src/mail/index.ts`.
 */
export interface OutgoingMail {
  to:       string
  subject:  string
  text?:    string
  html?:    string
}

export interface App {
  db?:      unknown          // captured by plugin from opts
  mail?:    { send(msg: OutgoingMail): Promise<void> }
  channel?: (name: string) => { send(event: string, payload: unknown): void } | undefined
  notify?:  (user: User, notification: Notification) => Promise<void>
  /**
   * Junction's guarded namespace claim. Used when present so a second plugin
   * claiming `app.notify` fails loudly instead of silently winning; falls back
   * to plain assignment against an older Junction.
   */
  provide?: (name: string, value: unknown) => void
}

// ─── Plugin options ───────────────────────────────────────────────────────────

export interface NotificationsPluginOptions {
  db:        unknown          // Litestone client
  channels?: {
    email?:  { mailer?: string }
    sms?:    { provider?: string }
    [key: string]: NotificationDriver | { mailer?: string } | { provider?: string } | undefined
  }
}

// ─── Delivery error detail ────────────────────────────────────────────────────

export interface ChannelError {
  channel: string
  error:   unknown
}

// Avoid circular — re-export Notification type reference
import type { Notification } from './notification.ts'
