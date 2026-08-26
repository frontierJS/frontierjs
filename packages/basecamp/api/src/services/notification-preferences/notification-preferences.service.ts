// src/services/notification-preferences/notification-preferences.service.ts
// What one person wants to be told about, and how.
//
// Mounted at /notification-preferences. **Takes no workspace**, like
// /blueprints and for the opposite reason: a blueprint belongs to everybody and
// a preference belongs to exactly one person. `NotificationPreference` is
// `@@tenant(none)` with `@@allow('all', userId == auth().id)`, so the Data
// boundary confines every read and write to the caller's own rows and this file
// never writes a `userId` filter of its own.
//
// ─── find answers seven rows and stores fewer ─────────────────────────────
//
// A row exists only where somebody has CHOSEN. `find` merges what is stored
// over `kinds.ts`'s defaults, so a person who has never opened the screen sees
// the seven kinds with the answer they are actually getting rather than an
// empty list — and `source` says which of the two each row came from, because
// *defaulted to on* and *turned on* are different facts and a screen that
// cannot tell them apart cannot explain itself.

import { createService, BadRequest, Unauthorized, $ } from '@frontierjs/junction'
import { db }                                         from '../../core/resource.ts'
import type { BasecampApp }                           from '../../basecamp.types.ts'
import { NOTIFICATION_KINDS, NOTIFICATION_KIND_NAMES, notificationKind } from './kinds.ts'

/** The caller, or a refusal. The Data boundary would refuse a stranger anyway —
 *  `@@gate("1")` is VISITOR — but it refuses with a level, and somebody who is
 *  simply signed out needs the sentence. */
function me(): string {
  const id = ($.me as { userId?: string } | null | undefined)?.userId
  if (!id) throw new Unauthorized('Sign in to manage your notification preferences')
  return id
}

export function createNotificationPreferencesService(_app: BasecampApp) {
  return createService({
    name:  'notification-preferences',
    model: 'NotificationPreference',

    // No `channel:`. `workspaceChannel` is the only channel this app has and
    // these rows belong to no workspace — broadcasting one would hand a
    // person's own settings to everybody they share a workspace with.
    methods: ['find', 'save', 'reset'],

    /** The seven kinds, stored answers over defaults. */
    async find() {
      const userId = me()
      const stored = new Map<string, any>(
        (await db().notificationPreference.findMany({ where: { userId } }))
          .map((r: any) => [r.kind, r]))

      return {
        total: NOTIFICATION_KINDS.length,
        data:  NOTIFICATION_KINDS.map(def => {
          const row = stored.get(def.kind)
          return {
            kind:        def.kind,
            label:       def.label,
            description: def.description,
            email:       row ? row.email : def.email,
            inApp:       row ? row.inApp : def.inApp,
            // `default` means nobody has chosen — which is not the same as
            // having chosen the same values, and only this can tell them apart.
            source:      row ? 'chosen' : 'default',
            updatedAt:   row?.updatedAt ?? null,
          }
        }),
      }
    },

    /**
     * Set one kind.
     *
     * Collection-level and not `patch`: the natural key is (person, kind) and
     * the row's uuid is something no screen has ever seen. A caller states the
     * kind; who they are is not theirs to state.
     */
    async save() {
      const userId = me()
      const data   = ($.data ?? {}) as Record<string, unknown>
      const kind   = String(data.kind ?? '')

      if (!notificationKind(kind)) throw new BadRequest(
        `Unknown notification kind '${kind}'. One of: ${NOTIFICATION_KIND_NAMES.join(', ')}`)

      const patch: Record<string, unknown> = {}
      if (typeof data.email === 'boolean') patch.email = data.email
      if (typeof data.inApp === 'boolean') patch.inApp = data.inApp
      if (!Object.keys(patch).length) throw new BadRequest(
        'Send `email` and/or `inApp` as booleans — there is nothing else to set')

      const existing = await db().notificationPreference.findFirst({ where: { userId, kind } })
      if (existing) {
        await db().notificationPreference.update({ where: { id: existing.id }, data: patch })
      } else {
        // A first choice about one transport still writes a whole row, so the
        // other transport is stamped from the kind's default rather than from
        // the column's — otherwise turning email ON for `deploy_success` would
        // silently turn its in-app notice off, the column defaulting to true
        // and the kind's default being the thing the person was looking at.
        const def = notificationKind(kind)!
        await db().notificationPreference.create({
          data: { userId, kind, email: def.email, inApp: def.inApp, ...patch },
        })
      }

      return { kind, ...patch }
    },

    /** Forget a choice, so the kind goes back to its default. */
    async reset() {
      const userId = me()
      const kind   = String((($.data ?? {}) as Record<string, unknown>).kind ?? '')

      if (kind && !notificationKind(kind)) throw new BadRequest(
        `Unknown notification kind '${kind}'. One of: ${NOTIFICATION_KIND_NAMES.join(', ')}`)

      // No kind means all of them — which is the *reset to defaults* button and
      // is why this is a method rather than a delete by id.
      const where = kind ? { userId, kind } : { userId }
      const { count } = await db().notificationPreference.deleteMany({ where })
      return { reset: kind ? [kind] : NOTIFICATION_KIND_NAMES, rows: count ?? 0 }
    },
  })
}
