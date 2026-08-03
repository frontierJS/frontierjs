import type { App, NotificationDriver, NotificationsPluginOptions, User } from './types.ts'
import type { Notification } from './notification.ts'
import { notify } from './notify.ts'

/**
 * notificationsPlugin — wires app.notify and registers channel drivers.
 *
 * Must be configured after mailerPlugin if the email channel is used:
 *
 * @example
 * // api/server.ts
 * import { notificationsPlugin } from '@frontierjs/notifications'
 *
 * app.configure(mailerPlugin(createResendMailer({ apiKey, from })))
 * app.configure(notificationsPlugin({
 *   db,
 *   channels: {
 *     email: { mailer: 'default' },          // uses app.mail
 *     slack: new SlackDriver({ webhookUrl }) // custom driver
 *   }
 * }))
 *
 * // After configure, app.notify is available everywhere:
 * await app.notify(user, new PaymentReceived(payment))
 *
 * // From a service hook via ctx.app:
 * await ctx.app.notify(user, new WelcomeUser())
 */
export function notificationsPlugin(opts: NotificationsPluginOptions) {
  // Declare the mailer dependency to Junction ONLY when the email channel is
  // actually configured — an app that notifies in-app only must not be forced
  // to install a mailer.
  //
  // A registered custom email driver replaces app.mail, so it needs no mailer.
  // Junction checks this before any boot() and fails naming both plugins.
  // Before it existed, "mailerPlugin must be configured before
  // notificationsPlugin" was a comment in an examples file, and getting it
  // wrong surfaced as a failed send long after startup rather than at boot.
  const emailChannel   = opts.channels?.email
  const emailUsesMailer = !!emailChannel &&
    typeof (emailChannel as { send?: unknown }).send !== 'function'

  return {
    name: 'notifications',
    ...(emailUsesMailer ? { requires: ['mailer'] } : {}),

    register(app: App) {
      // Build driver registry from plugin options
      const drivers = new Map<string, NotificationDriver>()

      if (opts.channels) {
        for (const [channelName, config] of Object.entries(opts.channels)) {
          // Anything with send() is a driver and is registered under its channel
          // name — including a built-in name like 'inApp' or 'email', which acts
          // as an explicit override (notify() prefers a registered driver).
          //
          // 'email' and 'sms' used to be skipped unconditionally, so an SMS
          // driver could never be registered and SMS was unimplementable; and
          // 'inApp' was registered but never read. Plain config objects like
          // { mailer: 'default' } or { provider: 'x' } have no send() and are
          // still ignored here — they configure the built-in path.
          if (config && typeof (config as NotificationDriver).send === 'function') {
            drivers.set(channelName, config as NotificationDriver)
          }
        }
      }

      // Attach db and drivers to app — accessed internally by notify()
      // Using symbol-prefixed keys to avoid colliding with app surface area
      const enrichedApp = app as App & {
        _db:      unknown
        _drivers: Map<string, NotificationDriver>
      }

      enrichedApp._db      = opts.db
      enrichedApp._drivers = drivers

      // Set app.notify — closes over enrichedApp so the public signature is clean:
      // app.notify(user, notification) — no app arg needed at call site
      const notifyFn = (user: User, notification: Notification): Promise<void> =>
        notify(user, notification, enrichedApp)

      // provide() refuses to overwrite an existing claim — two plugins owning
      // one name used to be last-write-wins, and the loser just stopped working.
      if (typeof app.provide === 'function') app.provide('notify', notifyFn)
      else app.notify = notifyFn
    },
  }
}
