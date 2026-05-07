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
  return {
    name: 'notifications',

    register(app: App) {
      // Build driver registry from plugin options
      const drivers = new Map<string, NotificationDriver>()

      if (opts.channels) {
        for (const [channelName, config] of Object.entries(opts.channels)) {
          // Skip built-in channel config objects — those are handled natively
          if (channelName === 'email' || channelName === 'sms') continue

          // Custom driver — must implement NotificationDriver interface
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
      app.notify = (user: User, notification: Notification): Promise<void> => {
        return notify(user, notification, enrichedApp)
      }
    },
  }
}
