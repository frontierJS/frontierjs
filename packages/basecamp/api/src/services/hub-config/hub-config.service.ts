// src/services/hub-config/hub-config.service.ts
// The installation's own settings — one row, behind the hub tier.
//
// Mounted at /hub-config. Sibling of /hub rather than part of it: `hub` is a
// service over no model that reads across every tenant, and this is a service
// over ONE model with one row. Folding them together would put a `model:` on a
// service whose other twelve methods answer for none.
//
// ─── Two methods, not five ────────────────────────────────────────────────
//
// A singleton does not have a collection and does not have an id a caller
// should know. `find` would have to answer a list of one, and `get` would make
// every screen hardcode the constant `'hub'`. So `methods:` names `current` and
// `save`, and junction answers 405 to the CRUD verbs — which is the surface
// being honest rather than a restriction.
//
// ─── Why validation is the Data boundary's here ───────────────────────────
//
// `autoValidate` derives from the model for `create`/`patch`, and neither is
// mounted. Litestone validates the same rules on the write itself and throws
// with an `errors` array, which junction's error boundary adopts ahead of its
// `data` — so a bad `baseUrl` still lands under the right box in a form. One
// validator, reached by a different door.

import { createService, BadRequest, NotFound, $ } from '@frontierjs/junction'
import { requireSystemAdmin }         from '../../core/hooks.ts'
import { db }                         from '../../core/resource.ts'
import type { BasecampApp }           from '../../basecamp.types.ts'

/** The primary key, which is a constant. `HubConfig.id` defaults to it, so this
 *  is the same string the schema writes and not a second opinion about it. */
const HUB = 'hub'

/**
 * The columns a caller may set. An allow-list rather than a strip: `id` would
 * let a caller mint a SECOND settings row, which is the one failure a singleton
 * has, and `updatedAt`/`version` are the boundary's.
 */
const WRITABLE = [
  'name', 'baseUrl', 'adminEmail',
  'heartbeatTimeoutSeconds', 'sessionTtlHours',
  'requireTwoFactorForOwners', 'allowApiKeyAuth', 'allowBotUsers',
  'backupEnabled', 'backupCron', 'backupDestination',
  'mailFromAddress', 'mailFromName',
]

export function createHubConfigService(_app: BasecampApp) {
  return createService({
    name:  'hub-config',
    model: 'HubConfig',

    methods: ['current', 'save'],

    /**
     * The settings, or a 404 saying they have never been written.
     *
     * NOT an invented row of defaults. `baseUrl` and `adminEmail` are required
     * with no default because nothing can guess them, and answering a
     * synthesised object would let a screen show settings that are not stored —
     * every reader would then have to know which of them were real.
     */
    async current() {
      const row = await db().hubConfig.findFirst({ where: { id: HUB } })
      if (!row) throw new NotFound(
        'This installation has no settings yet. Save them once to create them — ' +
        'a base URL and an admin email are required and nothing can infer either.'
      )
      return row
    },

    /**
     * Write them. Creates the row the first time, updates it after.
     *
     * An upsert rather than create-or-patch, because the caller cannot know
     * which it is and asking them to find out is a round trip that races
     * itself: two administrators opening the screen on a fresh install would
     * both be told to create.
     */
    async save() {
      const data: Record<string, unknown> = {}
      for (const key of WRITABLE) {
        const value = ($.data as Record<string, unknown>)?.[key]
        if (value !== undefined) data[key] = value
      }

      const existing = await db().hubConfig.findFirst({ where: { id: HUB } })
      if (!existing) return await db().hubConfig.create({ data: { ...data, id: HUB } })

      // `@version` on this model means a second administrator saving over a form
      // the first one had open is a 409 rather than a silent overwrite — so an
      // update MUST carry the revision it read, and litestone refuses one that
      // does not. Refused here instead, naming the field, because litestone's
      // own sentence explains the column and this one explains the call.
      const version = ($.data as Record<string, unknown>)?.version
      if (version === undefined) throw new BadRequest(
        'Send `version` — the revision of the settings you are editing. It comes back ' +
        'with `current`, and it is what makes a second administrator saving over your ' +
        'form a conflict rather than a silent overwrite.')

      return await db().hubConfig.update({ where: { id: HUB }, data: { ...data, version } })
    },

    hooks: {
      before: { all: [requireSystemAdmin()] },
    },
  })
}
