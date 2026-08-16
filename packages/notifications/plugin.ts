import type { App, NotificationDriver, NotificationsPluginOptions, Recipient } from './types.ts'
import type { Notification } from './notification.ts'
import { setState } from './state.ts'
import { notify } from './notify.ts'

/**
 * notificationsPlugin — wires app.notify and registers transport drivers.
 *
 * Must be configured after mailerPlugin if the email transport is used:
 *
 * @example
 * // api/server.ts
 * import { notificationsPlugin } from '@frontierjs/notifications'
 *
 * app.configure(mailerPlugin(createResendMailer({ apiKey, from })))
 * app.configure(notificationsPlugin({
 *   db,
 *   transports: {
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
  // `channels:` was this option's name until FJS-D06 ruled Channel to be
  // junction's broadcast set and a delivery medium to be a Transport. An
  // unknown key would otherwise configure nothing and be discovered as a
  // missing driver at first send.
  const legacy = (opts as { channels?: unknown }).channels
  if (legacy !== undefined) {
    throw new Error(
      '[notifications] `channels:` is now `transports:` — a delivery medium is a ' +
      'Transport, and `channel` is junction\'s broadcast set (FJS-285). Rename the ' +
      'option; the values are unchanged.'
    )
  }

  // Declare the mailer dependency to Junction ONLY when the email transport is
  // actually configured — an app that notifies in-app only must not be forced
  // to install a mailer.
  //
  // A registered custom email driver replaces app.mail, so it needs no mailer.
  // Junction checks this before any boot() and fails naming both plugins.
  // Before it existed, "mailerPlugin must be configured before
  // notificationsPlugin" was a comment in an examples file, and getting it
  // wrong surfaced as a failed send long after startup rather than at boot.
  const emailTransport   = opts.transports?.email
  const emailUsesMailer  = !!emailTransport &&
    typeof (emailTransport as { send?: unknown }).send !== 'function'

  const drivers = new Map<string, NotificationDriver>()

  return {
    name: 'notifications',
    ...(emailUsesMailer ? { requires: ['mailer'] } : {}),

    register(app: App) {
      if (opts.transports) {
        for (const [transportName, config] of Object.entries(opts.transports)) {
          // Anything with send() is a driver and is registered under its
          // transport name — including a built-in name like 'inApp' or 'email',
          // which acts as an explicit override (notify() prefers a registered
          // driver).
          //
          // 'email' and 'sms' used to be skipped unconditionally, so an SMS
          // driver could never be registered and SMS was unimplementable; and
          // 'inApp' was registered but never read. Plain config objects like
          // { mailer: 'default' } or { provider: 'x' } have no send() and are
          // still ignored here — they configure the built-in path.
          if (config && typeof (config as NotificationDriver).send === 'function') {
            drivers.set(transportName, config as NotificationDriver)
          }
        }
      }

      // The db and the driver registry live under one symbol rather than as
      // two enumerable `_`-prefixed properties on the app.
      setState(app, { db: opts.db, drivers })

      // Set app.notify — closes over the app so the public signature stays
      // clean: app.notify(recipient, notification), no app arg at the call site
      const notifyFn = (recipient: Recipient, notification: Notification): Promise<void> =>
        notify(recipient, notification, app)

      // claim() refuses to overwrite an existing claim — two plugins owning
      // one name used to be last-write-wins, and the loser just stopped working.
      if (typeof app.claim === 'function') app.claim('notify', notifyFn)
      else app.notify = notifyFn
    },

    // `requires: ['mailer']` proves the PLUGIN is configured; this proves the
    // mailer it was supposed to install is actually on the app. A mailer plugin
    // that registered and left `app.mail` unset used to be found by the first
    // email notification of the deployment, which is hours after the process
    // that could have refused to start.
    boot(app: App) {
      if (emailUsesMailer && !app.mail) {
        throw new Error(
          '[notifications] the email transport is configured but app.mail is not set. ' +
          'Configure mailerPlugin(...) before notificationsPlugin(...), or register ' +
          'your own driver under transports.email.'
        )
      }
    },

    // A driver may hold a socket, an HTTP agent or a timer open. Each is closed
    // independently: one that throws is logged and the rest still run, because
    // a shutdown that stops halfway leaves the process alive for no stated
    // reason.
    async shutdown() {
      for (const [transport, driver] of drivers) {
        try {
          await driver.shutdown?.()
        } catch (err) {
          console.error(`[notifications] driver "${transport}" shutdown error:`, err)
        }
      }
    },
  }
}
