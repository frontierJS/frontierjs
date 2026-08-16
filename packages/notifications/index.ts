// ─── Core ─────────────────────────────────────────────────────────────────────

export { Notification }          from './notification.ts'
export { notificationsPlugin }   from './plugin.ts'

import type { Notification as NotificationBase } from './notification.ts'
import type { Recipient } from './types.ts'

// Contribute the real call signature of `app.notify` to Junction's augmentable
// slot. Junction declares `AppNotify` as an EMPTY interface and documents that
// this package fills it in — but nothing here ever did, so `app.notify(user, n)`
// was TS2349 ("this expression is not callable") for every TypeScript consumer.
// The package never noticed because it type-checks against its own structural
// `App` in types.ts, not Junction's.
//
// Augment the interface — never redeclare `App.notify`. Declaration merging
// requires identical types, so a redeclaration is TS2717 and loses silently.
// See the AppConduit note in the repo CLAUDE.md.
declare module '@frontierjs/junction' {
  interface AppNotify {
    (recipient: Recipient, notification: NotificationBase): Promise<void>
  }
}

// ─── Builders ─────────────────────────────────────────────────────────────────

export { inApp, mail }           from './builders.ts'

// ─── Errors ───────────────────────────────────────────────────────────────────

export {
  NotificationDeliveryError,
  NotificationDriverNotFoundError,
  NotificationRecipientError,
  NotificationTransportNotImplementedError,
} from './errors.ts'

// ─── Types ────────────────────────────────────────────────────────────────────

export type {
  Transport,
  BuiltInTransport,
  InAppMessage,
  InAppAction,
  MailMessage,
  MailLine,
  SmsMessage,
  NotificationRecord,
  NotificationDriver,
  NotificationsPluginOptions,
  OutgoingMail,
  TransportError,
  Recipient,
  App,
} from './types.ts'
