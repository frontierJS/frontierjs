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
  deliveryKey?: string,
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
        findFirst(opts: { where: Record<string, unknown> }): Promise<NotificationRecord | null>
      }
    }
  }
  const rows = litestone.asSystem().notification
  const type = notification.notificationType

  // A keyed send that already has its row is a retry: the first attempt wrote
  // and pushed, and a later transport failed. The column is written only when
  // a key is declared, so an app copy of the model without `deliveryKey` keeps
  // working for every notification that declares none.
  if (deliveryKey !== undefined) {
    const where = { userId: recipient.id, type, deliveryKey }
    if (await rows.findFirst({ where })) return
  }

  let record: NotificationRecord
  try {
    record = await rows.create({
      data: {
        userId:      recipient.id,
        type,
        data:        data,
        contextType: message.contextType ?? null,
        // The column is String; an integer id arrives as a number from a builder.
        contextId:   message.contextId == null ? null : String(message.contextId),
        ...(deliveryKey !== undefined && { deliveryKey }),
      },
    })
  } catch (err) {
    // Two keyed sends racing past the lookup: the @@unique refuses the second,
    // and the row it wanted is there.
    if (deliveryKey !== undefined && (err as Error)?.name === 'UniqueConflictError') return
    throw err
  }

  // Publish WS event — optional, degrades gracefully if channels not configured
  const channel = 'channel' in app ? app.channel?.(`notifications:user:${recipient.id}`) : undefined
  if (channel) {
    channel.send(CREATED_EVENT, record)
  }
}

/**
 * The frame a new notification is pushed as. The browser client routes a frame
 * to a service's live store only when its name is `<service> <verb>`, split on
 * the space; `notification:created` was one word to it, so every bell stayed
 * at its first load and nothing said why (FJS-1573). The service half is the
 * name an app mounts the in-app list under — `notifications`, which is also the
 * model's accessor and the channel's prefix.
 */
export const CREATED_EVENT = 'notifications created'
