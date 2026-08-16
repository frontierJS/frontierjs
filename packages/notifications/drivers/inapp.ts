import type { App, InAppMessage, NotificationRecord, Recipient } from '../types.ts'
import type { Notification } from '../notification.ts'
import { NotificationRecipientError } from '../errors.ts'

/**
 * InApp transport driver.
 *
 * Responsibilities:
 *   1. Build the data payload from InAppMessage
 *   2. Persist a notification record via db.asSystem() — bypasses gate + policy
 *   3. Publish a WS event via app.channel() if the channels plugin is configured
 *
 * `app.channel()` here is junction's BROADCAST channel — the other reading of
 * the word, and the one it keeps (FJS-D06). What this file is a driver for is a
 * transport.
 *
 * Degrades gracefully when the channels plugin is absent — the DB record still
 * persists, the WS push is skipped without error. Real-time delivery requires
 * the channels() plugin to be configured.
 *
 * db.asSystem() is used deliberately — create is locked at gate level (@@gate
 * create=8). Notifications are system-only writes; app users cannot POST to
 * /notifications directly.
 */
export async function sendInApp(
  recipient:    Recipient,
  notification: Notification,
  message:      InAppMessage,
  app:          App,
  db:           unknown,
): Promise<void> {
  // notify() refuses this before any transport runs. Restated here because the
  // driver is also reachable directly, and a row keyed by `undefined` is the
  // one failure this transport cannot report later (FJS-096).
  if (recipient.id == null) {
    throw new NotificationRecipientError(
      'inApp', notification.notificationType,
      'the recipient has no id to key the notification row by.'
    )
  }

  // Build the data payload — merge title/body/action with arbitrary data fields
  const data: Record<string, unknown> = {
    ...message.data,
  }
  if (message.title)  data.title  = message.title
  if (message.body)   data.body   = message.body
  if (message.action) data.action = message.action

  // Persist via db.asSystem() — bypasses gate (create=8) and policy
  const litestone = db as {
    asSystem(): {
      notification: {
        create(opts: { data: Record<string, unknown> }): Promise<NotificationRecord>
      }
    }
  }

  const record = await litestone.asSystem().notification.create({
    data: {
      userId:      recipient.id,
      type:        notification.notificationType,
      data:        data,
      contextType: message.contextType ?? null,
      contextId:   message.contextId   ?? null,
    },
  })

  // Publish WS event — optional, degrades gracefully if channels not configured
  // app.channel() returns undefined when the channels() plugin is absent
  const channel = app.channel?.(`notifications:user:${recipient.id}`)
  if (channel) {
    channel.send('notification:created', record)
  }
}
