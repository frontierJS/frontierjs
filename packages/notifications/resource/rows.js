// resource/rows.js — what NotificationBell and NotificationList do with a row.
//
// Every write is `notifications.mutate(id, intent, run)`. A bare
// `notifications.service.patch` announces nothing to a per-person channel, so
// the row stays unread in every list that holds it and the bell's count does
// not drop until a reload (FJS-2111). Both components take the app's
// `notifications` resource and write through it here, so there is one place a
// bare service call could creep in.

/** Newest first, stated by the CLIENT: the tether places a pushed row by the
 *  order its load asked for, and the service's own default is invisible to it,
 *  so a push would land at the bottom of a list read top-down. */
export const INBOX = { orderBy: '-createdAt', limit: 50 }

export const isUnread = (n) => !n.readAt

/** The inApp driver merges `title`, `body` and `action` into `data` beside the
 *  type's own keys; a row written before a type had a title still renders. */
export const titleOf = (n) => n.data?.title ?? n.type
export const bodyOf = (n) => n.data?.body ?? ''
export const actionOf = (n) => n.data?.action ?? null

const mark = (notifications, n, body) =>
  notifications.mutate(n.id, body, () => notifications.service.patch(n.id, body))

export const markRead = (notifications, n) => mark(notifications, n, { readAt: new Date().toISOString() })
export const markUnread = (notifications, n) => mark(notifications, n, { readAt: null })

/** One mutate per unread row, so each shows read at once. A bulk service
 *  method would be an updateMany, which announces nothing and would leave the
 *  tether showing rows the server has already marked. Answers the count. */
export async function markAllRead(notifications, rows) {
  const unread = rows.filter(isUnread)
  const settled = await Promise.allSettled(unread.map((n) => markRead(notifications, n)))
  const failed = settled.find((s) => s.status === 'rejected')
  if (failed) throw failed.reason
  return unread.length
}
