// src/services/backup-destinations/backup-destinations.service.ts
// Backup destinations — the bucket an archive is sent to (`FJS-D1488`).
//
// Mounted at /backup-destinations. Workspace-scoped like /channels, because
// the credential is a `Secret` and a `Secret` has a workspace (`FJS-D1491`);
// the hub's own schedule points at one from above, `HubConfig.backupDestinationId`.
//
// **The credential is not on this row.** An access key pair reaches every
// archive in the bucket, so `create` lifts the material into a `Secret`
// (`@encrypted`, written once, never read back) and keeps the reference. What
// stays on the row is an address: endpoint, region, bucket, prefix. The whole
// row comes back on a read while the credential never does — the one path
// back out is conduit's resolver, at send time (core/credentials.ts).
//
// **A write registers the target.** `storage:s3:<id>` is upserted on create
// and on every patch, because the address changes under a patch to `endpoint`
// or `region` and conduit's registry is what the job sends through
// (providers/storage/index.ts). `test` — a PUT and a DELETE of a probe key —
// is `IDEAS/backups.md` 1.8, not here yet.

import { createService, BadRequest, Conflict, $ } from '@frontierjs/junction'
import { sessionScope, workspaceChannel, getPagination, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { db, findScoped, getScoped, removeScoped, restoreScoped, narrowPatch, changesNothing, actor }
  from '../../core/resource.ts'
import { registerDestination, unregisterDestination } from '../../providers/storage/index.ts'
import { splitCredential } from '../../providers/storage/s3.ts'
import { keyScope } from '../api-keys/scopes.ts'
import type { App } from '@frontierjs/junction'

type Row = Record<string, unknown> & { id: string; endpoint: string; region: string; bucket: string; prefix: string; secretId?: string | null }

/** A destination plus how many archives name it — what `remove` refuses on,
 *  and what makes a row legible on the list. */
async function withBackupCount(row: Record<string, unknown>) {
  const backup_count = await db().asSystem().backup.count({ where: { destinationId: row.id } })
  return { ...row, backup_count }
}

/** The shape is checked here and not only at send: a credential that cannot
 *  be split is a destination that fails at 02:00 with `auth_failed`, where a
 *  person pressing Create is looking now. */
function checkCredential(value: string): void {
  try { splitCredential(value) } catch (e) { throw new BadRequest((e as Error).message) }
}

/**
 * Lift the credential out of the payload and into a Secret. The plaintext is
 * never written to BackupDestination and never returned.
 */
async function storeCredential(name: string, value: string): Promise<string> {
  const secret = await db().secret.create({
    data: {
      // The unique is [workspaceId, name] and a destination's name is already
      // unique in the workspace. The prefix keeps it out of the way of secrets
      // a person authored.
      name:      `backup:${name}`,
      kind:      'backup',
      data:      value,
      createdBy: actor(),
    },
  })
  return secret.id as string
}

export default createService({
  name:  'backup-destinations',
  scope: keyScope('backup-destinations'),
  model: 'BackupDestination',
  paginate: { default: 20, max: 200 },
  methods: ['find', 'get', 'aggregate', 'create', 'update', 'patch', 'remove', 'restore'],
  channel: workspaceChannel,
  reservedQuery: WORKSPACE_QUERY,

  async find() {
    const { limit, offset } = getPagination()
    const page = await findScoped('backupDestination', { orderBy: { name: 'asc' }, limit, offset })
    const data = await Promise.all((page.data as Record<string, unknown>[]).map(withBackupCount))
    return { ...page, data }
  },

  async get() {
    return withBackupCount(await getScoped('backupDestination', 'Backup destination'))
  },

  async create() {
    const data = $.data as Record<string, unknown>
    // `secret` is @transient — validated by the model's own rules and lifted
    // off the payload by autoValidate, so `data` is columns only.
    const credential = $.transients.secret as string | undefined
    if (!credential) throw new BadRequest('A destination needs a credential — send it as `secret`, as `<accessKeyId>:<secretAccessKey>`')
    checkCredential(credential)

    data.secretId  = await storeCredential(data.name as string, credential)
    data.createdBy = actor()

    const row = await db().backupDestination.create({ data, system: ['secretId'] }) as Row
    await registerDestination($.app as App, row)
    return withBackupCount(row)
  },

  async patch() {
    const row  = await getScoped('backupDestination', 'Backup destination') as Row
    const data = $.data as Record<string, unknown>
    const credential = $.transients.secret as string | undefined
    const patch = narrowPatch(data)

    if (credential) {
      checkCredential(credential)
      if (row.secretId) {
        // Rotate in place — the target's ref keeps resolving, and `isVerified`
        // goes false the way the secrets service does it. `Secret` is
        // @version, so the write carries the revision it just read.
        const held = await db().secret.findFirst({ where: { id: row.secretId as string } })
        if (!held) throw new BadRequest('The credential this destination points at is gone — remove and recreate the destination')
        await db().secret.update({
          where: { id: held.id as string },
          data:  { data: credential, isVerified: false, version: held.version },
        })
      } else {
        patch.secretId = await storeCredential(row.name as string, credential)
      }
    }

    const updated = changesNothing(patch)
      ? row
      : await db().backupDestination.update({
          where: { id: row.id }, data: patch,
          system: 'secretId' in patch ? ['secretId'] : [],
        }) as Row
    // Re-registered on every patch: the address or the region may have moved,
    // and the registry is an upsert.
    await registerDestination($.app as App, updated)
    return withBackupCount(updated)
  },

  async remove() {
    const row = await getScoped('backupDestination', 'Backup destination') as Row

    // Refused rather than orphaned: a `Backup` row that names this destination
    // has its archive in this bucket, and a destination that vanishes under
    // it is an archive nobody can reach from the screen. Prune the rows first.
    const named = await db().asSystem().backup.count({ where: { destinationId: row.id } })
    if (named > 0)
      throw new Conflict(`${named} backup(s) are recorded in this destination — remove those rows first`)

    const removed = await removeScoped('backupDestination', 'Backup destination')
    await unregisterDestination($.app as App, row.id)
    // The Secret goes with it: a key whose only reader is gone is a live
    // credential nothing is watching. Soft-delete, like the row.
    if (row.secretId) await db().secret.remove({ where: { id: row.secretId as string } })
    return removed
  },

  // The credential comes back with it, and so does the target.
  async restore() {
    const row = await restoreScoped('backupDestination', 'Backup destination') as Row
    if (row.secretId) await db().secret.restore({ where: { id: row.secretId as string } })
    await registerDestination($.app as App, row)
    return withBackupCount(row)
  },

  hooks: {
    before: { all: [sessionScope()] },
  },
})
