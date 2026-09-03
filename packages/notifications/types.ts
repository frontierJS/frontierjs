// ─── Transport names ──────────────────────────────────────────────────────────
//
// A TRANSPORT is a delivery medium — in-app, email, SMS, Slack. It is not a
// Channel: FJS-D06 rules Channel to be junction's broadcast set, which this
// package also uses (the in-app driver publishes on `app.channel(...)`), and
// the two words sat fourteen lines apart in this file meaning different things.

export type BuiltInTransport = 'inApp' | 'email' | 'sms'
export type Transport        = BuiltInTransport | string   // open for custom drivers

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
  to?:      string    // optional override — defaults to recipient.email

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
  to?:  string        // optional override — defaults to recipient.phone
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
  transport: string
  send(recipient: Recipient, message: unknown, app: App): Promise<void>
  /**
   * Release whatever the driver holds open — a socket, a client, a timer.
   * Awaited once, on app shutdown, and a throw is logged rather than rethrown:
   * one driver that cannot close must not stop the next one from trying.
   */
  shutdown?(): void | Promise<void>
}

// ─── Who a notification is addressed to ──────────────────────────────────────

/**
 * The unit of address. **Not a user** — a shop customer, a mailing-list
 * address and a signed-in account are all recipients, and only the last has a
 * row anything can read.
 *
 * `id` is therefore optional, and that is the whole of FJS-096: an in-app
 * notification is a row keyed by `userId`, so addressing one to a recipient
 * with no id (or with an invented `customer:42`) writes a row nobody can ever
 * read, with no error. `notify()` now refuses an id-less recipient on `inApp`
 * by name, before any transport runs — and an app that has no user row for
 * somebody says so by leaving `id` off rather than making one up.
 *
 * An app supplies a richer type; the extra keys travel untouched and are what
 * `via()` and the `to*()` formatters read (`recipient.firstName`, a
 * preferences column).
 */
export interface Recipient {
  id?:     number | string
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
  mail?:    { send(msg: OutgoingMail): Promise<void> }
  /** Junction's broadcast channel — the other reading of the word, and the one it keeps. */
  channel?: (name: string) => { send(event: string, payload: unknown): void } | undefined
  notify?:  (recipient: Recipient, notification: Notification) => Promise<void>
  /**
   * Junction's guarded namespace claim. Used when present so a second plugin
   * claiming `app.notify` fails loudly instead of silently winning; falls back
   * to plain assignment against an older Junction.
   */
  claim?: (name: string, value: unknown) => void
}

// ─── Plugin options ───────────────────────────────────────────────────────────

export interface NotificationsPluginOptions {
  db:          unknown          // Litestone client

  /**
   * Where this app's `*.notification.ts` files are.
   *
   * Absent, two candidates are probed beside the entry — `notifications/` and
   * `src/notifications/` — which is the flat layout and the scaffolded one. A
   * stated path is never probed around: a relative path resolved against the
   * wrong working directory lands on nothing and is indistinguishable from an
   * app that declares none, so a miss throws naming what it looked at.
   *
   * `false` turns loading off. Definitions then have to state `type:`, because
   * nothing will have named them.
   */
  notifications?: string | false

  transports?: {
    email?:    { mailer?: string }
    sms?:      { provider?: string }
    [key: string]: NotificationDriver | { mailer?: string } | { provider?: string } | undefined
  }
}

// ─── Delivery error detail ────────────────────────────────────────────────────

export interface TransportError {
  transport: string
  error:     unknown
}

// Avoid circular — re-export Notification type reference
import type { Notification } from './notification.ts'
