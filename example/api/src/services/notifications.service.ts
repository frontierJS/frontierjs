import { createBaseService } from '@frontierjs/junction'
import type { ServiceContext } from '@frontierjs/junction'

// The in-app half of a notification. Nothing here says "only your own" — that
// is `@@allow('read', userId == auth().id)` on the model, enforced at the Data
// boundary for every caller including this one, because `ctx.locals.db` is the
// per-request client scoped to the session.
//
// `methods` is the whole access story that a gate cannot tell:
//
//   find    list mine
//   get     one of mine
//   patch   mark it read
//
// No create — a notification is written by `notify()` through `asSystem()`, and
// the model's gate says 8 for create, so an offered `POST /api/notifications`
// would be a 403 with a route in front of it. No remove: read is what happens
// to a notification, not deletion. Declaring the list is what makes those
// answer 405 with a sentence naming what IS offered, rather than existing as
// four hand-written stubs or, worse, as writable endpoints nobody looked at.

export function createNotificationsService() {
  return createBaseService({
    methods: ['find', 'get', 'patch'],
    channel: 'notifications',

    hooks: {
      before: {
        // Newest first by default. A notification list read oldest-first is
        // technically correct and useless — and `$orderBy` still overrides it,
        // because this only fills in a directive the caller did not state.
        find: [(ctx: ServiceContext) => {
          ctx.directives ??= {}
          ctx.directives.orderBy ??= '-createdAt'
        }],

        // Marking one read is the only update there is. Anything else in the
        // body is dropped rather than refused: the row belongs to the system,
        // and a client that tries to rewrite `type` or `data` should not get a
        // 400 that teaches it those fields are patchable at all.
        patch: [(ctx: ServiceContext) => {
          const wanted = (ctx.data ?? {}) as { readAt?: unknown }
          ctx.data = { readAt: 'readAt' in wanted ? wanted.readAt : new Date().toISOString() }
        }],
      },
    },
  })
}
