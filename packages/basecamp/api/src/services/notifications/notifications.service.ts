// src/services/notifications/notifications.service.ts
// The in-app half of a notification — what the bell and /notifications/ read.
//
// Mounted at /notifications, and the name is not a free choice: the inApp
// driver pushes `notifications created` to `notifications:user:<id>`, and the
// browser client routes that frame into the store of the service NAMED by its
// first word. Renaming this service would leave every bell at its first load.
//
// **Takes no workspace**, for notification-preferences' reason: a notification
// is addressed to a person, and a person is in several workspaces.
// `Notification` is `@@tenant(none)` with `@@allow('read'|'update', userId ==
// auth().id)`, so the Data boundary confines every read and write to the
// caller's own rows and this file never writes a `userId` filter.
//
//   find     mine, newest first
//   get      one of mine
//   patch    mark it read, or unread with an explicit null
//   readAll  mark everything read
//
// No create: the only writer is the driver, through `asSystem()`, and the gate
// says 8. No remove: reading is what happens to a notification.

import { createService, Unauthorized, $ } from '@frontierjs/junction'
import type { ServiceContext }            from '@frontierjs/junction'
import { db }                             from '../../core/resource.ts'
import type { BasecampApp }               from '../../basecamp.types.ts'

/** The Data boundary would answer a stranger with an empty list — read is
 *  open and the policy scopes it — which reads as *you have no notifications*
 *  rather than *you are signed out*. */
function signedIn(_ctx?: ServiceContext): void {
  if (!($.me as { userId?: string } | null | undefined)?.userId) {
    throw new Unauthorized('Sign in to read your notifications')
  }
}

export function createNotificationsService(_app: BasecampApp) {
  return createService({
    name:    'notifications',
    model:   'Notification',
    methods: ['find', 'get', 'patch', 'readAll'],

    /** Mark every unread notification read. Answers how many it marked, so
     *  the bell can say so without a second read. */
    async readAll() {
      const { count } = await db().notification.updateMany({
        where: { readAt: null },
        data:  { readAt: new Date().toISOString() },
      })
      return { count }
    },

    hooks: {
      before: {
        all: [signedIn],

        // A notification list read oldest-first is correct and useless.
        // `$orderBy` still overrides it: this fills a directive, never replaces one.
        find: [function newestFirst(ctx: ServiceContext) {
          ctx.directives ??= {}
          ctx.directives.orderBy ??= '-createdAt'
        }],

        // `readAt` is the one column a recipient writes. An empty body marks
        // the row read now, by the server's clock; an explicit null marks it
        // unread (Invariant 9). Anything else is dropped rather than refused,
        // as `example` does for the same model: the row is the system's, and a
        // 400 naming `data` would teach a client that `data` is patchable.
        patch: [function readAtOnly(ctx: ServiceContext) {
          const wanted = (ctx.data ?? {}) as { readAt?: unknown }
          ctx.data = { readAt: 'readAt' in wanted ? wanted.readAt : new Date().toISOString() }
        }],
      },
    },
  })
}
