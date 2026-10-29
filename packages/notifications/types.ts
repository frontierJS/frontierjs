// ─── Transport names ──────────────────────────────────────────────────────────
//
// A TRANSPORT is a delivery medium — in-app, email, SMS, Slack. It is not a
// Channel: FJS-D06 rules Channel to be junction's broadcast set, which this
// package also uses (the in-app driver publishes on `app.channel(...)`), and
// the two words sat fourteen lines apart in this file meaning different things.

// Every other name — sms, push, slack — is a registered driver. The type is read
// off this list so the two cannot disagree about what ships.
export const BUILT_IN_TRANSPORTS = ['inApp', 'email'] as const

export type BuiltInTransport = typeof BUILT_IN_TRANSPORTS[number]
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
  subjectType?: string
  subjectId?:   number | string | null
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
  to?:      string | string[]    // optional override — defaults to recipient.email

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

  /**
   * Files that travel with the mail — an `.ics` on a booking confirmation.
   * Junction's own `MailAttachment`, imported rather than restated, and handed
   * to the mailer untouched.
   */
  attachments?: MailAttachment[]
}

// ─── Push message ─────────────────────────────────────────────────────────────

export interface PushAction {
  label: string
  url:   string
}

/**
 * What a `push:` formatter answers. ONE shape for both `push` drivers, so a
 * definition formats once whichever one the app registered -- `webPush()` reads
 * the payload fields and the delivery options, `ntfy()` reads the phone fields.
 * A driver drops what it cannot carry rather than refusing it.
 */
export interface PushMessage {
  title?:    string
  body?:     string
  /** Where a click goes -- the service worker reads it from the payload; ntfy sends it as `Click`. */
  url?:      string
  data?:     Record<string, unknown>
  /** Seconds the push service may hold it for an offline device. Default one day. webPush only. */
  ttl?:      number
  /** webPush only -- the service's queueing hint, not the phone's. */
  urgency?:  'very-low' | 'low' | 'normal' | 'high'
  /** A later message with the same topic replaces one still queued or still on screen -- the
   *  header for the push service, the payload for the worker's `tag`. webPush only. */
  topic?:    string
  /** Sent even to a recipient with a tab of the app on screen, which is otherwise skipped
   *  (`FJS-D1627`). Read by the driver, never in the payload. webPush only. */
  always?:   boolean
  /** ntfy only. 5 breaks through do-not-disturb; a resend is 4; default 3. */
  priority?: 1 | 2 | 3 | 4 | 5
  /** ntfy only -- emoji shortcodes (`rotating_light`) shown before the title. */
  tags?:     string[]
  /** ntfy only -- one `view` button each. */
  actions?:  PushAction[]
}

// ─── Stored notification record (mirrors schema.lite model) ──────────────────

export interface NotificationRecord {
  id:          number
  userId:      number | string
  type:        string
  data:        Record<string, unknown>
  subjectType: string | null
  subjectId:   string | null
  /** The definition's `key`, absent on a copy of the model that has no column. */
  deliveryKey?: string | null
  readAt:     string | null
  createdAt:   string
}

// ─── Custom driver interface ──────────────────────────────────────────────────

export interface NotificationDriver {
  transport: string
  /**
   * What the vendor answered -- a message id a delivery receipt will name
   * later. `notify()` hands it back under this driver's transport; answering
   * nothing is fine. A refusal THROWS, and an error class the driver defines
   * is how it says whether the send may still have gone out.
   */
  send(recipient: Recipient, message: unknown, app: App): Promise<unknown>
  /**
   * Release whatever the driver holds open — a socket, a client, a timer.
   * Awaited once, on app shutdown, and a throw is logged rather than rethrown:
   * one driver that cannot close must not stop the next one from trying.
   */
  shutdown?(): void | Promise<void>
}

/**
 * What `notify()` answers: each registered driver's `send()` answer, by
 * transport. A transport whose driver answered nothing, and the built-in
 * `inApp` and `email`, have no key.
 */
export type NotificationReceipts = Record<string, unknown>

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
  /** A list is ONE mail addressed to all of them, not one mail each. */
  email?:  string | string[]
  phone?:  string
  /** The ntfy topic a `push` ping is published to -- an address, not a device. */
  pushTopic?: string
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
  to:       string | string[]
  subject:  string
  text?:    string
  html?:    string
  attachments?: MailAttachment[]
}

// Junction's `AppMail` is `{}` until its mail module is imported, which is what
// augments it to `IMail`. An app with no mailer — in-app notifications alone —
// never imports it, and junction's App was then unassignable to this one
// (`mail` has no `send`), so `app.configure(notifications(…))` failed
// `tsc`. Type-only: no runtime import. `MailAttachment` is junction's own, so
// the one field that crosses carries no second definition.
import type { MailAttachment } from '@frontierjs/junction/mail'

export interface App {
  // `Promise<unknown>` and not `Promise<void>`: junction's `IMail.send` answers
  // a `SendResult` receipt, and under `strictFunctionTypes` a `void` return here
  // makes junction's own App unassignable to this one — so
  // `app.configure(notifications(…))` could not typecheck in ANY app that
  // ran `tsc`. The driver awaits the send and discards the receipt, which is
  // correct: a failure THROWS, and `SendResult` is `{ id, message }`.
  //
  // Same drift the email driver's header already names one field along. A
  // structural copy of somebody else's interface is a copy, and it goes stale.
  mail?:    { send(msg: OutgoingMail): Promise<unknown> }
  /** Junction's broadcast channel — the other reading of the word, and the one it keeps. */
  channel?: (name: string) => { send(event: string, payload: unknown): void } | undefined
  /** Junction's channel manager; the push driver asks it whether a tab is on screen. */
  channels?: { hasVisibleConnection(userId: string | number): boolean }
  /** `createApp({ root })` — definitions load from `notifications/` beside it (`FJS-D1080`). */
  root?:    string | null
  notify?:  (recipient: Recipient, notification: Notification) => Promise<NotificationReceipts>
  /**
   * Junction's guarded namespace owner. Used when present so a second plugin
   * owning `app.notify` fails loudly instead of silently winning; falls back
   * to plain assignment against an older Junction.
   */
  own?: (name: string, value: unknown) => void
}

// ─── Plugin options ───────────────────────────────────────────────────────────

export interface NotificationsPluginOptions {
  db:          unknown          // Litestone client

  /**
   * A driver per transport name. `email: { mailer }` is the one plain object
   * accepted — it selects the built-in email path over `app.mail`, and
   * `'default'` (that one mailer) is the only name it takes. Any other mailer
   * name, or any other value without `send()`, is refused at construction,
   * since it would configure nothing.
   */
  transports?: {
    email?:    NotificationDriver | { mailer?: string }
    [key: string]: NotificationDriver | { mailer?: string } | undefined
  }

  /**
   * The services this package registers at boot, by the name each is served
   * under. `false` registers none; a name set to `false` drops that one, and a
   * string renames it — the way out when the app already serves that name.
   * `pushSubscriptions` registers only when the schema installs `PushSubscription`.
   */
  services?: false | { pushSubscriptions?: string | false }
}

// ─── Delivery error detail ────────────────────────────────────────────────────

export interface TransportError {
  transport: string
  error:     unknown
}

// Avoid circular — re-export Notification type reference
import type { Notification } from './notification.ts'
