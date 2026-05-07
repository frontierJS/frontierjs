import type { App, InAppMessage, NotificationRecord, User } from '../types.ts'
import type { Notification } from '../notification.ts'

/**
 * InApp channel driver.
 *
 * Responsibilities:
 *   1. Build the data payload from InAppMessage
 *   2. Persist a notification record via db.asSystem() — bypasses gate + policy
 *   3. Publish a WS event via app.channel() if channels plugin is configured
 *
 * Degrades gracefully when channels plugin is absent — DB record still
 * persists, WS push is skipped without error. Real-time delivery requires
 * the channels() plugin to be configured.
 *
 * db.asSystem() is used deliberately — create is locked at gate level (@@gate
 * create=9). Notifications are system-only writes; app users cannot POST to
 * /notifications directly.
 */
export async function sendInApp(
  user:         User,
  notification: Notification,
  message:      InAppMessage,
  app:          App & { _db: unknown }
): Promise<void> {
  const db = app._db as Record<string, unknown>

  // Build the data payload — merge title/body/action with arbitrary data fields
  const data: Record<string, unknown> = {
    ...message.data,
  }
  if (message.title)  data.title  = message.title
  if (message.body)   data.body   = message.body
  if (message.action) data.action = message.action

  // Persist via db.asSystem() — bypasses gate (create=9) and policy
  const litestone = db as {
    asSystem(): {
      notification: {
        create(opts: { data: Record<string, unknown> }): Promise<NotificationRecord>
      }
    }
  }

  const record = await litestone.asSystem().notification.create({
    data: {
      userId:      user.id,
      type:        notification.notificationType,
      data:        data,
      contextType: message.contextType ?? null,
      contextId:   message.contextId   ?? null,
    },
  })

  // Publish WS event — optional, degrades gracefully if channels not configured
  // app.channel() returns undefined when channels() plugin is absent
  const channel = app.channel?.(`notifications:user:${user.id}`)
  if (channel) {
    channel.send('notification:created', record)
  }
}
