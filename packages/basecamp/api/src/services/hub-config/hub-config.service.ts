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
// `data` — so a bad retention count still lands under the right box in a form.
// One validator, reached by a different door.
//
// ─── Three keys that are the hub App's ────────────────────────────────────
//
// The hub's schedule, archive destination and replica are its App row's
// (`FJS-D1606`). `save` takes `backupCron`, `backupDestinationId` and
// `replicaDestinationId` and writes them there, at system, because /hub/settings/
// is the one screen that sets them; `current` answers them under `app`.

import { createService, BadRequest, Conflict, NotFound, $ } from '@frontierjs/junction'
import { requireSystemAdmin }         from '../../core/hooks.ts'
import { db, narrowPatch, changesNothing } from '../../core/resource.ts'
import { encryptionKeyFingerprint }   from '../../core/db.ts'
import { keyScope } from '../../domain/api-key/scopes.ts'
import { cronProblem, syncAppBackupSchedule } from '../../domain/job/job-schedule.ts'
import { replicaHolder, syncHostReplica } from '../../jobs/replicate-sync.job.ts'
import { hubSummary, requireHubAppId } from '../../domain/host/host-machine.ts'

/** The primary key, which is a constant. `HubConfig.id` defaults to it, so this
 *  is the same string the schema writes and not a second opinion about it. */
const HUB = 'hub'

/** The keys `save` writes on the hub App rather than on this row. */
const HUB_APP_KEYS = ['backupCron', 'backupDestinationId', 'replicaDestinationId'] as const

/**
 * Check and write the hub App's keys, then put the clock and Basecamp's
 * replica list in line with the row. A moved replica pointer is a new list on
 * Basecamp's box. Refused before the settings row is written, so a save that
 * fails here changes nothing.
 */
async function checkHubApp(keys: Record<string, unknown>): Promise<void> {
  if (changesNothing(keys)) return
  const sys = db().asSystem()
  const hub = await sys.app.findFirst({ where: { id: await requireHubAppId(sys) } })

  // Both destinations are a workspace's row pointed at from the hub tier
  // (`FJS-D1491`), so the lookup is at system; the FK would refuse an unknown
  // id too, but as a constraint sentence and not a field.
  for (const key of ['backupDestinationId', 'replicaDestinationId']) {
    const id = keys[key]
    if (id === undefined || id === null) continue
    const found = await sys.backupDestination.findFirst({ where: { id } })
    if (!found) throw new BadRequest(`No backup destination '${id}'`)
    // Basecamp's box is sent only a replica of its own workspace's bucket
    // (`hostReplicaDestination`), so another's would be saved and never run.
    if (key === 'replicaDestinationId' && found.workspaceId !== hub.workspaceId)
      throw new BadRequest(`replicaDestinationId: '${found.name}' is in another workspace; Basecamp replicates to a destination of the workspace its App is in`)
  }
  // One destination is one replica's (`FJS-D1505`).
  if (typeof keys.replicaDestinationId === 'string') {
    const holder = await replicaHolder($.app, keys.replicaDestinationId)
    if (holder && 'app' in holder)
      throw new Conflict(`That destination replicates the app '${holder.app.slug}'; give Basecamp a destination of its own`)
  }
  if (typeof keys.backupCron === 'string') {
    const problem = cronProblem(keys.backupCron)
    if (problem) throw new BadRequest(`backupCron: ${problem}`)
  }
}

async function writeHubApp(keys: Record<string, unknown>): Promise<void> {
  if (changesNothing(keys)) return
  const sys   = db().asSystem()
  const appId = await requireHubAppId(sys)
  const row   = await sys.app.update({ where: { id: appId }, data: keys })
  syncAppBackupSchedule($.app, row)
  if ('replicaDestinationId' in keys) await syncHostReplica($.app)
}

/** The row as `current` answers it: the settings and the hub App beside them. */
async function answered(row: any) {
  return { ...row, app: await hubSummary(db().asSystem()) }
}

export default createService({
  name:  'hubConfig',
  scope: keyScope('hubConfig'),
  model: 'HubConfig',

  methods: ['current', 'save', 'attestEscrow', 'dismissFound'],

  /**
   * The settings, or a 404 saying they have never been written.
   *
   * NOT an invented row of defaults: answering a synthesized object would let
   * a screen show settings that are not stored — every reader would then have
   * to know which of them were real.
   */
  async current() {
    const row = await db().hubConfig.findFirst({ where: { id: HUB } })
    if (!row) throw new NotFound(
      'This installation has no settings yet. Save them once to create them.'
    )
    // `app` is the hub App (`FJS-D1603`): a save that sent it back would name
    // no column, so the screen takes it off the draft.
    return answered(row)
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
    const sent = { ...($.data as Record<string, unknown>) }
    const keys: Record<string, unknown> = {}
    for (const key of HUB_APP_KEYS) if (key in sent) { keys[key] = sent[key]; delete sent[key] }
    const { version, ...data } = narrowPatch(sent)
    await checkHubApp(keys)

    const existing = await db().hubConfig.findFirst({ where: { id: HUB } })
    let row = existing
    if (!existing) row = await db().hubConfig.create({ data: { ...data, id: HUB } })
    else {
      // `@version` on this model means a second administrator saving over a
      // form the first one had open is a 409 rather than a silent overwrite —
      // so an update MUST carry the revision it read, and litestone refuses
      // one that does not. Refused here instead, naming the field, because
      // litestone's own sentence explains the column and this one the call.
      if (version === undefined) throw new BadRequest(
        'Send `version` — the revision of the settings you are editing. It comes back ' +
        'with `current`, and it is what makes a second administrator saving over your ' +
        'form a conflict rather than a silent overwrite.')
      // A save of the hub App's keys alone still carries the revision it
      // read, so a stale form is a 409 here too.
      row = await db().hubConfig.update({ where: { id: HUB }, data: { ...data, version } })
    }
    await writeHubApp(keys)
    return answered(row)
  },

  /**
   * A person says a copy of ENCRYPTION_KEY is kept off this box.
   *
   * Nothing here can check that, so the row records WHEN and OF WHICH KEY —
   * its sha256, never the key — and `hub.key-escrowed` (`domain/host/posture.ts`)
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

  /** `/hub/backups/`'s *replica found* card declined (`domain/backup/found-replicas.ts`). */
  async dismissFound() {
    const sys = db().asSystem()
    await sys.app.update({
      where:  { id: await requireHubAppId(sys) },
      data:   { replicaFoundAt: null, replicaSyncedAt: null },
      system: ['replicaFoundAt', 'replicaSyncedAt'],
    })
    return answered(await db().hubConfig.findFirst({ where: { id: HUB } }))
  },

  hooks: {
    before: { all: [requireSystemAdmin()] },
  },
})
