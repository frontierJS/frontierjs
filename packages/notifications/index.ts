// ─── Core ─────────────────────────────────────────────────────────────────────

export { Notification }          from './notification.ts'
export { notificationsPlugin }   from './plugin.ts'

// ─── Builders ─────────────────────────────────────────────────────────────────

export { inApp, mail }           from './builders.ts'

// ─── Errors ───────────────────────────────────────────────────────────────────

export {
  NotificationChannelNotImplementedError,
  NotificationDeliveryError,
  NotificationDriverNotFoundError,
} from './errors.ts'

// ─── Types ────────────────────────────────────────────────────────────────────

export type {
  Channel,
  BuiltInChannel,
  InAppMessage,
  InAppAction,
  MailMessage,
  MailLine,
  SmsMessage,
  NotificationRecord,
  NotificationDriver,
  NotificationsPluginOptions,
  ChannelError,
  User,
  App,
} from './types.ts'
