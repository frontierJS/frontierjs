import type { App, NotificationDriver, NotificationsPluginOptions, NotificationReceipts, Recipient } from './types.ts'
import type { Notification } from './notification.ts'
import { setState } from './state.ts'
import { notify } from './notify.ts'
import { loadNotifications, sealRegistry } from './loader.ts'
import type { NotificationRegistry } from './loader.ts'

const isDriver = (v: unknown): v is NotificationDriver =>
  typeof (v as NotificationDriver | null)?.send === 'function'

/**
 * notifications — wires app.notify and registers transport drivers.
 *
 * Must be configured after junction's mail plugin if the email transport is used:
 *
 * @example
 * // api/server.ts
 * import { mail }          from '@frontierjs/junction/mail'
 * import { notifications } from '@frontierjs/notifications'
 *
 * app.configure(mail({ mailer: createResendMailer({ apiKey, from }) }))
 * app.configure(notifications({
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
export function notifications(opts: NotificationsPluginOptions) {
  // `sms: { provider: 'twilio' }` is the shape other frameworks take. There is
  // no built-in SMS to configure, so it registered nothing and was found at the
  // first send — which for an alert is the moment it was needed.
  for (const [transportName, config] of Object.entries(opts.transports ?? {})) {
    if (config === undefined || isDriver(config)) continue
    if (transportName === 'email' && typeof config === 'object' && config !== null) {
      // The built-in path sends through app.mail and there is exactly one, so
      // `default` is the only name that selects anything. Another name would
      // configure nothing and be found when mail left through the wrong mailer.
      const mailer = (config as { mailer?: unknown }).mailer
      if (mailer === undefined || mailer === 'default') continue
      throw new Error(
        `[notifications] transports.email.mailer "${String(mailer)}" names a mailer this app ` +
        'does not have. The built-in email path sends through app.mail, the one mailer, ' +
        'named `default`. To send through anything else, register your own driver under ' +
        '`transports.email`.'
      )
    }

    throw new Error(
      `[notifications] transports.${transportName} has no send(), so it configures ` +
      'nothing. Only `email` takes a plain object — `{ mailer }`, the built-in path ' +
      `over app.mail. Every other transport is a driver: register ` +
      `\`${transportName}: { send(recipient, message, app) { … } }\`.`
    )
  }

  // Declare the mailer dependency to Junction ONLY when the email transport is
  // actually configured — an app that notifies in-app only must not be forced
  // to install a mailer.
  //
  // A registered custom email driver replaces app.mail, so it needs no mailer.
  // Junction checks this before any boot() and fails naming both plugins.
  // Before it existed, "mail must be configured before
  // notifications" was a comment in an examples file, and getting it
  // wrong surfaced as a failed send long after startup rather than at boot.
  const emailTransport   = opts.transports?.email
  const emailUsesMailer  = !!emailTransport && !isDriver(emailTransport)

  const drivers = new Map<string, NotificationDriver>()
  let registry: NotificationRegistry = new Map()   // sealed once the loader answers

  return {
    name: 'notifications',
    ...(emailUsesMailer ? { requires: ['mailer'] } : {}),

    register(app: App) {
      // Anything with send() is a driver and is registered under its transport
      // name — a built-in name included, which overrides (notify() prefers a
      // registered driver). Everything else was refused at construction.
      for (const [transportName, config] of Object.entries(opts.transports ?? {})) {
        if (isDriver(config)) drivers.set(transportName, config)
      }

      // The db and the driver registry live under one symbol rather than as
      // two enumerable `_`-prefixed properties on the app.
      setState(app, { db: opts.db, drivers })

      // Set app.notify — closes over the app so the public signature stays
      // clean: app.notify(recipient, notification), no app arg at the call site
      const notifyFn = (recipient: Recipient, notification: Notification): Promise<NotificationReceipts> =>
        notify(recipient, notification, app)

      // own() refuses to overwrite an existing owner — two plugins owning
      // one name used to be last-write-wins, and the loser just stopped working.
      if (typeof app.own === 'function') app.own('notify', notifyFn)
      else app.notify = notifyFn
    },

    // `requires: ['mailer']` proves the PLUGIN is configured; this proves the
    // mailer it was supposed to install is actually on the app. A mailer plugin
    // that registered and left `app.mail` unset used to be found by the first
    // email notification of the deployment, which is hours after the process
    // that could have refused to start.
    // Autoload runs in boot() and not register(): register() is synchronous and
    // this reads the file system. Nothing sends before boot completes, and a
    // definition's type is stamped onto the module object every caller already
    // holds — so a file imported directly by a job is the same object the
    // loader named.
    async boot(app: App) {
      registry = app.root ? await loadNotifications(app.root) : sealRegistry(new Map())

      // Claimed so a devtools panel, a preferences screen or a snapshot can ask
      // what this app can send WITHOUT sending one. That is the whole reason a
      // definition holds `via` rather than closing over a payload.
      if (typeof app.own === 'function') app.own('notifications', registry)

      if (emailUsesMailer && !('mail' in app)) {
        throw new Error(
          '[notifications] the email transport is configured but app.mail is not set. ' +
          'Configure mail({ mailer }) from @frontierjs/junction/mail before notifications(...), or register ' +
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
