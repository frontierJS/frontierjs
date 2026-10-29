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
// (providers/storage/index.ts).
//
// **`test` really sends.** A PUT of a probe key under the prefix and the
// DELETE of it, through the same target the 02:00 job sends through — a test
// down a second path is a test of the second path. The stamp is written only
// when both answered, so `lastTestAt` means the key wrote and deleted here.
// A refusal comes back as the connector's failure kind said in words
// (`forbidden`, `clock_skew`, `refused`…), because a 403 is three different
// mistakes and only one of them is the credential.

import { createService, BadRequest, Conflict, $ } from '@frontierjs/junction'
import { LEVELS } from '@frontierjs/litestone'
import { sessionScope, workspaceChannel, getPagination, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { db, findScoped, getScoped, removeScoped, restoreScoped, narrowPatch, changesNothing, actor }
  from '../../core/resource.ts'
import { registerDestination, unregisterDestination, keyUnder, sendFor } from '../../providers/storage/index.ts'
import { splitCredential, putObject, deleteObject } from '../../providers/storage/s3.ts'
import type { S3Failure } from '../../providers/storage/s3.ts'
import { keyScope } from '../../domain/api-key/scopes.ts'
import { syncReplicasHeldBy, replicaHolder } from '../../jobs/replicate-sync.job.ts'
import { destinationFor } from '../../jobs/app-backup-run.job.ts'
import type { App } from '@frontierjs/junction'

type Row = Record<string, unknown> & { id: string; endpoint: string; region: string; bucket: string; prefix: string; secretId?: string | null; version: number }

/** The failure kind, said for the person at the form. The kind is the first
 *  word so a screen or a test can match on it; the S3 `<Code>` follows, since
 *  that is what a vendor's own docs name. */
export function explainFailure(step: 'write' | 'delete', f: S3Failure): string {
  const code = f.code ? ` (${f.code})` : ''
  const said: Record<string, string> = {
    forbidden:         `the bucket's policy refuses this key${code} — the application key needs read, write, list and delete on this bucket and prefix`,
    auth_failed:       `the key is not accepted${code} — check the credential is <accessKeyId>:<secretAccessKey> and the key still exists`,
    clock_skew:        `this machine's clock is more than fifteen minutes off the bucket's${code} — fix the clock, not the key`,
    missing:           `no such bucket${code} — the bucket name is wrong, or it is in another region`,
    refused:           `the bucket refused the request${code} — ${f.message}`,
    connection_failed: `the endpoint cannot be reached — ${f.message}`,
    timeout:           `the endpoint did not answer in time — ${f.message}`,
    target_not_found:  `this destination is not registered as a target — patch it once to re-register`,
  }
  const why = said[f.kind] ?? `${f.message}${code}`
  const left = step === 'delete' ? '; the probe key was written and is still in the bucket' : ''
  return `${f.kind}: the probe ${step} failed — ${why}${left}`
}

// ─── The slash ───────────────────────────────────────────────────────────
//
// An app's replica key is scoped to `<prefix>/<appId>/` and its archives are
// `<prefix>/<appId>-<stamp>.tar.gz`. A scope written without the slash reaches
// both, so a compromised app plants an archive that the next rescan records
// (`FJS-D1572`). Asked only where a rescan reads: the App's backup destination
// is this bucket and prefix.

async function refusesArchiveWrite(app: App, send: ReturnType<typeof sendFor>, row: Row, appId: string): Promise<void> {
  const target   = await (app.db as any).asSystem().app.findFirst({ where: { id: appId } })
  const archives = target && await destinationFor(app, target).catch(() => null)
  if (!archives || archives.endpoint !== row.endpoint || archives.bucket !== row.bucket
    || keyUnder(archives, '') !== keyUnder(row, '')) return

  const key = keyUnder(row, `${appId}-probe.tar.gz`)
  const put = await putObject(send, row.bucket, key, `basecamp scope probe ${new Date().toISOString()}\n`, { contentType: 'application/gzip' })
  if (put.error?.kind === 'forbidden') return
  if (put.error) throw new BadRequest(`${put.error.kind}: the scope probe could not tell whether this key reaches the app's archives — ${put.error.message}`)
  const del  = await deleteObject(send, row.bucket, key)
  const left = del.error ? `; ${key} is still in the bucket, delete it there` : ''
  throw new BadRequest(`scope: this key wrote ${key}, so it reaches the app's archives — scope it to '${keyUnder(row, `${appId}/`)}', with the trailing slash${left}`)
}

/** A destination plus how many archives name it — what `remove` refuses on,
 *  and what makes a row legible on the list. */
async function withBackupCount(row: Record<string, unknown>) {
  const backup_count = await archivesNaming(row.id as string)
  return { ...row, backup_count }
}

/** Every archive naming it, the hub's among them (`FJS-D1606`): each holds a
 *  key in this bucket and `Restrict` on the FK blocks the hard delete. */
async function archivesNaming(destinationId: string): Promise<number> {
  return db().asSystem().appBackup.count({ where: { destinationId } })
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
  name:  'backupDestinations',
  scope: keyScope('backupDestinations'),
  model: 'BackupDestination',
  paginate: { default: 20, max: 200 },
  // `test` sends real traffic to a third party under the workspace's name,
  // so it is not a read, and no model's gate grades it — the same bar as
  // `channels.test`.
  methods: ['find', 'get', 'aggregate', 'create', 'update', 'patch', 'remove', 'restore',
    { method: 'test', gate: LEVELS.ADMINISTRATOR }],
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
        // Rotate in place — the target's ref keeps resolving, and `verifiedAt`
        // clears the way the secrets service does it. `Secret` is
        // @version, so the write carries the revision it just read.
        const held = await db().secret.findFirst({ where: { id: row.secretId as string } })
        if (!held) throw new BadRequest('The credential this destination points at is gone — remove and recreate the destination')
        await db().secret.update({
          where: { id: held.id as string },
          data:  { data: credential, verifiedAt: null, verifyError: null, version: held.version },
          system: ['verifiedAt', 'verifyError'],
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
    // The app or hub replicating with this key holds it on a machine, so a
    // moved address or a rotated key is a new list there.
    await syncReplicasHeldBy($.app as App, row.id as string)
    return withBackupCount(updated)
  },

  async remove() {
    const row = await getScoped('backupDestination', 'Backup destination') as Row

    // Refused rather than orphaned: a `Backup` or `AppBackup` row that names
    // this destination has its archive in this bucket, and a destination that
    // vanishes under it is an archive nobody can reach from the screen. Prune
    // the rows first.
    const named = await archivesNaming(row.id)
    if (named > 0)
      throw new Conflict(`${named} backup(s) are recorded in this destination — remove those rows first`)

    const removed = await removeScoped('backupDestination', 'Backup destination')
    await unregisterDestination($.app as App, row.id)
    // The Secret goes with it: a key whose only reader is gone is a live
    // credential nothing is watching. Soft-delete, like the row.
    if (row.secretId) await db().secret.remove({ where: { id: row.secretId as string } })
    await syncReplicasHeldBy($.app as App, row.id as string)
    return removed
  },

  // The credential comes back with it, and so does the target.
  async restore() {
    const row = await restoreScoped('backupDestination', 'Backup destination') as Row
    if (row.secretId) await db().secret.restore({ where: { id: row.secretId as string } })
    await registerDestination($.app as App, row)
    await syncReplicasHeldBy($.app as App, row.id as string)
    return withBackupCount(row)
  },

  // ── test ──────────────────────────────────────────────────────────
  // PUT then DELETE a probe key under the prefix, through the registered
  // target. Both verbs on purpose: retention and `remove` delete, and a key
  // scoped to write-only passes a PUT and fails at 02:00 on the first prune.
  async test() {
    const row = await getScoped('backupDestination', 'Backup destination') as Row
    if (!row.secretId) throw new BadRequest('This destination holds no credential — patch it with one as `secret` first')

    const app    = $.app as App
    const send   = sendFor(app, row.id)
    const holder = await replicaHolder(app, row.id)
    const appId  = holder && 'app' in holder ? holder.app.id : null
    // Stamped and random: two administrators testing at once must not delete
    // each other's probe, and a key a vendor's lifecycle rule has already seen
    // is not reused. An app's key reaches its own replica path and no further,
    // so the probe goes there.
    const key  = keyUnder(row, `${appId ? `${appId}/` : ''}basecamp-probe-${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`)

    const put = await putObject(send, row.bucket, key, `basecamp probe ${new Date().toISOString()}\n`, { contentType: 'text/plain' })
    if (put.error) throw new BadRequest(explainFailure('write', put.error))
    const del = await deleteObject(send, row.bucket, key)
    if (del.error) throw new BadRequest(explainFailure('delete', del.error))
    if (appId) await refusesArchiveWrite(app, send, row, appId)

    // Not stamped on a failure — the stamp means the key wrote and deleted
    // here, and nothing else. The Secret's flag follows, since a rotation
    // cleared it and this is the one check that can set it again.
    const updated = await db().backupDestination.update({
      where: { id: row.id },
      data:  { lastTestAt: new Date().toISOString(), version: row.version },
      system: ['lastTestAt'],
    }) as Row
    const held = await db().secret.findFirst({ where: { id: row.secretId } })
    if (held && !held.verifiedAt)
      await db().secret.update({
        where:  { id: held.id as string },
        data:   { verifiedAt: new Date().toISOString(), verifyError: null, version: held.version },
        system: ['verifiedAt', 'verifyError'],
      })
    return withBackupCount(updated)
  },

  hooks: {
    before: { all: [sessionScope()] },
  },
})
