import type { App, ChannelError, InAppMessage, MailMessage, NotificationDriver, User } from './types.ts'
import type { Notification } from './notification.ts'
import {
  NotificationChannelNotImplementedError,
  NotificationDeliveryError,
  NotificationDriverNotFoundError,
} from './errors.ts'
import { sendInApp }  from './drivers/inapp.ts'
import { sendEmail }  from './drivers/email.ts'

// ─── Built-in channel names ───────────────────────────────────────────────────
//
// Channels this package implements natively. 'sms' is deliberately NOT here:
// there is no built-in SMS implementation, so declaring it built-in let
// validation pass and then failed at delivery with a bare Error. Treating it
// as a normal channel means it needs a registered driver, and a missing one is
// caught eagerly as NotificationDriverNotFoundError like any other.
const BUILT_IN_CHANNELS = new Set(['inApp', 'email'])

// ─── Message materialisation ─────────────────────────────────────────────────
//
// inApp() and mail() return chainable BUILDERS whose values live in private
// fields; build() turns one into the plain message the drivers read. The
// drivers never called it, so they read the chainable METHODS instead:
//
//   spread of `message.data`  (a function) → {}          → empty payload
//   `message.title`           (a function) → truthy      → a function in the JSON
//   `message.lines`           (no such method) → undefined → `?? []` → EMPTY EMAIL
//   `message.to`              (a function) → truthy      → the "no recipient"
//                                                          guard never fired
//
// so such a notification delivered an in-app row with an empty payload and an
// email with no subject and no body — and reported success.
//
// Scope, precisely: README.md and examples/ DO call .build(), and that path
// always worked. The JSDoc @example blocks in this package omitted it (now
// fixed), and TypeScript rejects the omission — InAppBuilder is not an
// InAppMessage. So the silent-empty case reached JavaScript consumers and
// anyone following editor hover text, not typed code that compiles.
//
// builders.ts already documented build() as "called internally by the driver".
// It wasn't. This is that call, in one place, so the failure mode is a working
// delivery rather than a silent empty one. Already-built messages have no
// build() method and pass through untouched.
function materialise(message: unknown): unknown {
  if (message && typeof (message as { build?: unknown }).build === 'function') {
    return (message as { build(): unknown }).build()
  }
  return message
}

// ─── notify() — package-internal, not exported ───────────────────────────────

/**
 * Core delivery function. Called by app.notify() which closes over `app`
 * so the public signature stays clean: app.notify(user, notification).
 *
 * Execution:
 *   1. Call notification.via(user) to get channel list
 *   2. Validate eagerly — throw before any delivery if:
 *      - a channel has no toChannel() method (NotificationChannelNotImplementedError)
 *      - a channel has no registered driver  (NotificationDriverNotFoundError)
 *   3. Execute all channels in parallel via Promise.allSettled
 *      — channel isolation: a failed email does not block inApp delivery
 *   4. Collect failures, throw NotificationDeliveryError if any channel failed
 */
export async function notify(
  user:         User,
  notification: Notification,
  app:          App & { _db: unknown; _drivers: Map<string, NotificationDriver> }
): Promise<void> {
  const channels         = notification.via(user)
  const notificationType = notification.notificationType

  // ── Step 1: Eager validation — fail fast before any delivery ─────────────
  for (const channel of channels) {
    // Check toChannel() is implemented
    const message = notification.getMessageFor(channel, user)
    if (message === undefined) {
      throw new NotificationChannelNotImplementedError(channel, notificationType)
    }

    // Check driver exists for non-built-in channels
    if (!BUILT_IN_CHANNELS.has(channel) && !app._drivers.has(channel)) {
      throw new NotificationDriverNotFoundError(channel, notificationType)
    }
  }

  // ── Step 2: Parallel delivery ─────────────────────────────────────────────
  const results = await Promise.allSettled(
    channels.map(channel => deliverChannel(channel, user, notification, app))
  )

  // ── Step 3: Collect failures ──────────────────────────────────────────────
  const failures: ChannelError[] = []
  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    if (result.status === 'rejected') {
      failures.push({ channel: channels[i], error: result.reason })
    }
  }

  if (failures.length > 0) {
    // Log each failed channel with full detail before throwing
    for (const failure of failures) {
      console.error(
        `[notifications] channel "${failure.channel}" failed for ` +
        `${notificationType} → user ${user.id}:`,
        failure.error
      )
    }
    throw new NotificationDeliveryError(notificationType, failures)
  }
}

// ─── Per-channel delivery dispatch ───────────────────────────────────────────

async function deliverChannel(
  channel:      string,
  user:         User,
  notification: Notification,
  app:          App & { _db: unknown; _drivers: Map<string, NotificationDriver> }
): Promise<void> {
  // A registered driver always wins, including for a built-in channel name.
  // Previously the switch ran first, so a custom `inApp` driver was accepted by
  // the plugin, stored in the registry, and then never consulted — the built-in
  // wrote its row and the override was silently ignored. Explicit configuration
  // should not lose to a default.
  const driver = app._drivers.get(channel)
  if (driver) {
    await driver.send(user, materialise(notification.getMessageFor(channel, user)), app)
    return
  }

  switch (channel) {
    case 'inApp': {
      const message = materialise(notification.toInApp!(user)) as InAppMessage
      await sendInApp(user, notification, message, app as Parameters<typeof sendInApp>[3])
      break
    }

    case 'email': {
      const message = materialise(notification.toEmail!(user)) as MailMessage
      await sendEmail(user, message, app)
      break
    }

    default: {
      // Unreachable: notify() validates that every non-built-in channel has a
      // registered driver before any delivery starts.
      throw new NotificationDriverNotFoundError(channel, notification.notificationType)
    }
  }
}
