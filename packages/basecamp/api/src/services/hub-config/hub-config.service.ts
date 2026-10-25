// src/services/hub-config/hub-config.service.ts
// The installation's own settings — one row, behind the hub tier.
//
// Mounted at /hub-config. Sibling of /hub rather than part of it: `hub` is a
// service over no model that reads across every tenant, and this is a service
// over ONE model with one row. Folding them together would put a `model:` on a
// service whose other twelve methods answer for none.
//
// ─── Three methods, not five ──────────────────────────────────────────────
//
// A singleton does not have a collection and does not have an id a caller
// should know. `find` would have to answer a list of one, and `get` would make
// every screen hardcode the constant `'hub'`. So `methods:` names `current`,
// `save` and `attestEscrow`, and junction answers 405 to the CRUD verbs — which
// is the surface being honest rather than a restriction.
//
// ─── Why validation is the Data boundary's here ───────────────────────────
//
// `autoValidate` derives from the model for `create`/`patch`, and neither is
// mounted. Litestone validates the same rules on the write itself and throws
// with an `errors` array, which junction's error boundary adopts ahead of its
// `data` — so a bad `baseUrl` still lands under the right box in a form. One
// validator, reached by a different door.

import { createService, BadRequest, Conflict, NotFound, $ } from '@frontierjs/junction'
import { requireSystemAdmin }         from '../../core/hooks.ts'
import { db, narrowPatch, changesNothing } from '../../core/resource.ts'
import { encryptionKeyFingerprint }   from '../../core/db.ts'
import { keyScope } from '../api-keys/scopes.ts'
import { cronProblem, syncBackupSchedule } from '../jobs/job-schedule.ts'
import { replicaHolder, syncHostReplica } from '../../jobs/replicate-sync.job.ts'

/** The primary key, which is a constant. `HubConfig.id` defaults to it, so this
 *  is the same string the schema writes and not a second opinion about it. */
const HUB = 'hub'

/** The clock follows the row it was saved as (`job-schedule.ts`). */
function synced<T extends { backupEnabled: boolean; backupCron: string }>(row: T): T {
  syncBackupSchedule($.app, row)
  return row
}

/** Write the destination pointers at system, then put the clock and the
 *  replica list in line with the row. A moved replica pointer is a new list
 *  on Basecamp's box. */
async function pointed(pointers: Record<string, unknown>, row: any): Promise<any> {
  if (!changesNothing(pointers))
    row = await db().asSystem().hubConfig.update({ where: { id: HUB }, data: pointers })
  synced(row)
  if ('replicaDestinationId' in pointers) await syncHostReplica($.app)
  return row
}

export default createService({
  name:  'hub-config',
  scope: keyScope('hub-config'),
  model: 'HubConfig',

  methods: ['current', 'save', 'attestEscrow'],

  /**
   * The settings, or a 404 saying they have never been written.
   *
   * NOT an invented row of defaults. `baseUrl` and `adminEmail` are required
   * with no default because nothing can guess them, and answering a
   * synthesized object would let a screen show settings that are not stored —
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
    // `id` would let a caller mint a SECOND settings row, the one failure a
    // singleton has; the schema withholds it with the stamps, and `version` is
    // the precondition and not a column to write.
    const { version, ...data } = narrowPatch($.data as Record<string, unknown>)

    // Both destinations are a workspace's row pointed at from the hub tier
    // (`FJS-D1491`), so the lookup is at system; the FK would refuse an
    // unknown id too, but as a constraint sentence and not a field.
    for (const key of ['backupDestinationId', 'replicaDestinationId']) {
      const id = data[key]
      if (id === undefined || id === null) continue
      const found = await db().asSystem().backupDestination.findFirst({ where: { id } })
      if (!found) throw new BadRequest(`No backup destination '${id}'`)
    }
    // One destination is one replica's (`FJS-D1505`).
    if (typeof data.replicaDestinationId === 'string') {
      const holder = await replicaHolder($.app, data.replicaDestinationId)
      if (holder && 'app' in holder)
        throw new Conflict(`That destination replicates the app '${holder.app.slug}'; give Basecamp a destination of its own`)
    }

    if (typeof data.backupCron === 'string') {
      const problem = cronProblem(data.backupCron)
      if (problem) throw new BadRequest(`backupCron: ${problem}`)
    }

    // The pointers name a tenant's row from a row of no tenant's, which
    // Litestone's hidden-parent check refuses unless written at system — and
    // a whole-row system write would also lift `@system` and let this method
    // forge the key escrow. So they are written alone, after the rest.
    const pointers: Record<string, unknown> = {}
    for (const key of ['backupDestinationId', 'replicaDestinationId'])
      if (key in data) { pointers[key] = data[key]; delete data[key] }

    const existing = await db().hubConfig.findFirst({ where: { id: HUB } })
    if (!existing) return pointed(pointers, await db().hubConfig.create({ data: { ...data, id: HUB } }))

    // `@version` on this model means a second administrator saving over a form
    // the first one had open is a 409 rather than a silent overwrite — so an
    // update MUST carry the revision it read, and litestone refuses one that
    // does not. Refused here instead, naming the field, because litestone's
    // own sentence explains the column and this one explains the call.
    if (version === undefined) throw new BadRequest(
      'Send `version` — the revision of the settings you are editing. It comes back ' +
      'with `current`, and it is what makes a second administrator saving over your ' +
      'form a conflict rather than a silent overwrite.')

    // A save of the pointers alone still carries the revision it read, so a
    // stale form is a 409 here too.
    if (changesNothing(data)) return pointed({ ...pointers, version }, existing)
    return pointed(pointers, await db().hubConfig.update({ where: { id: HUB }, data: { ...data, version } }))
  },

  /**
   * A person says a copy of ENCRYPTION_KEY is kept off this box.
   *
   * Nothing here can check that, so the row records WHEN and OF WHICH KEY —
   * its sha256, never the key — and `hub.key-escrowed` (`core/posture.ts`)
   * grades the attestation against the key in use: a regenerated key voids it
   * on its own. Both columns are `@system`, so `save` cannot forge one. The
   * development placeholder is refused: it is in the repo, and attesting a
   * copy of it would grade a dev box green for a key production refuses.
   */
  async attestEscrow() {
    const fingerprint = encryptionKeyFingerprint()
    if (!fingerprint) throw new BadRequest(
      'ENCRYPTION_KEY is the development placeholder, which is public — there is ' +
      'nothing to keep a copy of. Set a real one (openssl rand -hex 32) and attest that.')
    const existing = await db().hubConfig.findFirst({ where: { id: HUB } })
    if (!existing) throw new NotFound(
      'This installation has no settings yet. Save them once, then attest the key.')
    return db().hubConfig.update({
      where:  { id: HUB },
      data:   { encryptionKeyEscrowedAt: new Date().toISOString(), encryptionKeyFingerprint: fingerprint, version: existing.version },
      system: ['encryptionKeyEscrowedAt', 'encryptionKeyFingerprint'],
    })
  },

  hooks: {
    before: { all: [requireSystemAdmin()] },
  },
})
