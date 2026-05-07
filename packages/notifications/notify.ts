import type { App, ChannelError, NotificationDriver, User } from './types.ts'
import type { Notification } from './notification.ts'
import {
  NotificationChannelNotImplementedError,
  NotificationDeliveryError,
  NotificationDriverNotFoundError,
} from './errors.ts'
import { sendInApp }  from './drivers/inapp.ts'
import { sendEmail }  from './drivers/email.ts'

// ─── Built-in channel names ───────────────────────────────────────────────────

const BUILT_IN_CHANNELS = new Set(['inApp', 'email', 'sms'])

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
  switch (channel) {
    case 'inApp': {
      const message = notification.toInApp!(user)
      await sendInApp(user, notification, message, app as Parameters<typeof sendInApp>[3])
      break
    }

    case 'email': {
      const message = notification.toEmail!(user)
      await sendEmail(user, message, app)
      break
    }

    case 'sms': {
      // SMS driver — deferred until Conduit SMS provider is available
      throw new Error('SMS channel is not yet implemented.')
    }

    default: {
      // Custom driver — looked up from plugin-registered drivers map
      const driver  = app._drivers.get(channel)!
      const message = notification.getMessageFor(channel, user)
      await driver.send(user, message, app)
      break
    }
  }
}
