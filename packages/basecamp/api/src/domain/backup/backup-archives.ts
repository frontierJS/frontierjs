// src/domain/backup/backup-archives.ts
// An archive once it exists: where its local copy is, the one way it is
// deleted, which ones retention lets go, and the rescan that gives a row to
// one found in the bucket with none — the hub's (`FJS-D1493`) and an app's
// (`FJS-D1572`).
//
// ─── One delete, derived from the name ────────────────────────────────────
//
// The hub's archives are `AppBackup` rows on the hub App (`FJS-D1606`), so
// every read of them here names its `appId` — a row of any other App is an
// app volume's, which has none of this file's local directories.
//
// Retention, the warm-copy drop and `backups.discard` all delete through
// `deleteArchive` (`FJS-D1494`). A local directory is `backups/<name>` with
// `<name>` taken from the row's `location` and refused unless it is an archive
// name this file mints — never the stored path, because `location` is a
// column and an unlink of whatever a column says can reach the live database
// beside it. A remote archive goes object first and row second, so a delete
// the vendor refused leaves a row the next prune retries rather than an
// object nothing lists. The object goes version by version (`FJS-D1809`): a
// plain DELETE on a versioned bucket writes a marker and says yes while the
// archive stays, and a version the bucket's Object Lock holds is kept with a
// why starting `locked`, which is the lock working rather than a failure.
//
// ─── Whose object it is ───────────────────────────────────────────────────
//
// Two hubs can be pointed at one bucket and prefix, so a hub archive's name
// carries the install id minted on `HubConfig` (`FJS-D1797`):
// `basecamp-<installId>-<stamp>`, and the claim marker a hub puts under the
// prefix is `basecamp-claim-<installId>`. `isForeign(key, installId)` is the
// ONE answer to "is this another hub's": the rescan that adopts, the delete
// that prunes and the refusal of a claimed prefix all ask it, so adoption and
// deletion cannot disagree. A name with no id is a pre-id archive: nobody's,
// so nothing foreign, and the hub that already holds its row keeps it.
//
// ─── Local and remote ─────────────────────────────────────────────────────
//
// Remote is a success row with a destination and no `error`: its `location`
// is an object key. Everything else that succeeded is local — no destination,
// or an upload that failed and left the directory as the only copy. Counted
// apart, remote per destination, so a bucket the hub stopped pointing at is
// still pruned.

import { existsSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { keyUnder, sendFor }  from '../../providers/storage/index.ts'
import { deleteEveryVersion, listObjects, putObject } from '../../providers/storage/s3.ts'
import type { ListedObject }  from '../../providers/storage/s3.ts'
import { destinationFor, mintDownload } from '../../jobs/app-backup-run.job.ts'
import { requireHubAppId } from '../host/host-machine.ts'
import { executorOn, isExecutor } from '../../providers/executor.ts'
import { NotFound }           from '@frontierjs/junction'
import type { App }           from '@frontierjs/junction'
import type { BackupDestination } from '#db/schema.d.ts'

/** The start time with `:` and `.` flattened to `-`, as both archive names carry it. */
const STAMP = String.raw`(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z`

const UUID = String.raw`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`

/** `basecamp-`, the install id when there is one, and the stamp: the hub's own archive. */
export const ARCHIVE_NAME = new RegExp(`^basecamp-(?:(${UUID})-)?${STAMP}$`)

const CLAIM_NAME = new RegExp(`^basecamp-claim-(${UUID})$`)

/** The name of the directory (and, with `.tar.gz`, the object) a hub mints. */
export const hubArchiveName = (installId: string, stamp: string) => `basecamp-${installId}-${stamp}`

/** The start time an archive's name carries, or null for a name this file did
 *  not mint. `owner` is `basecamp`, or an app's id for one of its archives. */
export function stampOf(name: string, owner = 'basecamp'): string | null {
  let parts: string[] | undefined
  if (owner === 'basecamp') parts = name.match(ARCHIVE_NAME)?.slice(2)
  else if (name.startsWith(`${owner}-`)) parts = name.slice(owner.length + 1).match(new RegExp(`^${STAMP}$`))?.slice(1)
  return parts ? `${parts[0]}T${parts[1]}:${parts[2]}:${parts[3]}.${parts[4]}Z` : null
}

/** The install a hub object was written by: an archive's or a claim marker's.
 *  Null for a pre-id archive and for any key that is not a hub's. */
export function writerOf(key: string): string | null {
  const name = basename(key).replace(/\.tar\.gz$/, '')
  return name.match(CLAIM_NAME)?.[1] ?? name.match(ARCHIVE_NAME)?.[1] ?? null
}

/** Is this hub object another install's. The one predicate the rescan, the
 *  delete and the claim check share (`FJS-D1797`). */
export function isForeign(key: string, installId: string): boolean {
  const writer = writerOf(key)
  return writer !== null && writer !== installId
}

/** This hub's install id (`HubConfig.installId`). Throws without the row: a
 *  hub with none has no archive to name. */
export async function hubInstallId(sys: { hubConfig: { findFirst(a: object): Promise<unknown> } }): Promise<string> {
  const cfg = await sys.hubConfig.findFirst({ where: { id: 'hub' }, select: { installId: true } }) as { installId: string } | null
  if (!cfg) throw new Error('This hub has no settings row, so its archives have no install id to carry')
  return cfg.installId
}

/**
 * Claim `dest`'s prefix for this hub, or refuse because another hub holds it.
 * The marker is a small object named for the install, so the check is a
 * listing of `basecamp-claim-` and nothing is read. A listing the vendor
 * refuses does not block the backup -- archives carry the id, so two hubs
 * cannot collide on a key -- it only leaves the sharing unnoticed, and is
 * answered as `unchecked` so the caller can say so.
 */
export async function claimPrefix(
  app: App, dest: Pick<BackupDestination, 'id' | 'name' | 'bucket' | 'prefix'>, installId: string,
): Promise<{ claimed: true } | { refused: string } | { unchecked: string }> {
  const send = sendFor(app, dest.id)
  const mine = keyUnder(dest, `basecamp-claim-${installId}`)
  let token: string | undefined, held = false
  do {
    const page = await listObjects(send, dest.bucket, { prefix: keyUnder(dest, 'basecamp-claim-'), continuationToken: token })
    if (page.error) return { unchecked: `'${dest.name}' refused the listing (${page.error.kind}): ${page.error.message}` }
    for (const o of page.objects!) {
      if (isForeign(o.key, installId)) return { refused:
        `'${dest.name}' prefix '${dest.prefix}' is already claimed by another Basecamp (${writerOf(o.key)}); ` +
        'give this hub a prefix of its own' }
      if (o.key === mine) held = true
    }
    token = page.nextToken ?? undefined
  } while (token)
  if (held) return { claimed: true }
  const { error } = await putObject(send, dest.bucket, mine, JSON.stringify({ installId, claimedAt: new Date().toISOString() }),
    { contentType: 'application/json' })
  return error ? { unchecked: `'${dest.name}' refused the claim marker (${error.kind}): ${error.message}` } : { claimed: true }
}

/** Where archives land — `backups/` beside the live database, so a bind mount
 *  that carries the data volume carries these with it. */
export function backupDir(app: App): string {
  const live = app.sqlite.filename
  // `:memory:` has no directory. A test env would otherwise write `backups/`
  // into the process CWD, which is somebody's repository.
  if (!live || live === ':memory:') return ''
  return join(dirname(live), 'backups')
}

/** The local directory a `location` names — a path or an object key alike. */
function localDir(app: App, location: string): string | null {
  const dir  = backupDir(app)
  const name = basename(location, '.tar.gz')
  return dir && ARCHIVE_NAME.test(name) ? join(dir, name) : null
}

type ArchiveRow = {
  id: string; status: string; destinationId: string | null; location: string | null; error: string | null
  startedAt?: string | null; createdAt?: string
}

export const isRemote = (r: ArchiveRow) => r.status === 'success' && !!r.destinationId && !r.error && !!r.location

/** The pre-signed GET a person downloads a remote archive by, saving as
 *  `name` — the hub's `backups.download` and an app's `appBackups.download`
 *  alike. The destination is read at SYSTEM: the caller proved the row first. */
export async function bucketDownload(app: App, row: ArchiveRow, name: string): Promise<{ url: string; name: string }> {
  const dest = await app.db!.asSystem().backupDestination.findFirst({ where: { id: row.destinationId! } })
  if (!dest) throw new NotFound(`Destination '${row.destinationId}' is gone, so ${row.location} cannot be reached`)
  return { url: await mintDownload(app, dest, row.location!, name), name }
}

/** The directory a local archive is, or null when this disk holds none for the
 *  row: a remote one, one that never finished, or one pruned or moved away. */
export function localArchive(app: App, row: ArchiveRow): string | null {
  if (row.status !== 'success' || !row.location || isRemote(row)) return null
  const dir = localDir(app, row.location)
  return dir && existsSync(dir) ? dir : null
}

/**
 * Delete the bucket object a remote row names, every version of it. Answers
 * why not when it could not, and null once it is gone.
 */
export async function deleteRemote(app: App, row: ArchiveRow): Promise<string | null> {
  const sys = app.db!.asSystem()
  const dest = await sys.backupDestination.findFirst({ where: { id: row.destinationId } })
  if (!dest) return `Destination '${row.destinationId}' is gone, so ${row.location} cannot be reached`
  if (writerOf(row.location!) && isForeign(row.location!, await hubInstallId(sys)))
    return `${row.location} belongs to another Basecamp on this prefix; left in place`
  if (!('conduit' in app)) return 'This process has no conduit'
  const done = await deleteEveryVersion(sendFor(app, dest.id), dest.bucket, row.location!)
  if ('locked' in done)
    return `locked: '${dest.name}' holds ${row.location} under its Object Lock${done.locked.until ? ` until ${done.locked.until}` : ''}`
  if ('error' in done) {
    const { error } = done
    return `'${dest.name}' refused the delete (${error.kind}${error.code ? `, ${error.code}` : ''}): ${error.message}`
  }
  return null
}

/**
 * One archive file deleted on a machine by its Outpost's `/backup/remove`, by
 * file name (`FJS-D2012`): `appBackups.discard` and `servers.discardArchive`
 * both come through here. Answers what went, or why not.
 */
export async function removeOnMachine(app: App, server: { id: string; name: string }, appId: string, name: string):
  Promise<{ removed: boolean; bytes: number } | { error: string }> {
  const executor = await executorOn(app, server.id, server.name)
  if (!isExecutor(executor)) return { error: executor.reason }
  const res = await executor.call('/backup/remove', { app_id: appId, path: name })
  if (res.error) return { error: `${server.name} did not delete it: ${res.error.message}` }
  const done = (res.data ?? {}) as { removed?: boolean; bytes?: number }
  return { removed: done.removed === true, bytes: done.bytes ?? 0 }
}

/**
 * Delete the archive a row names, then the row. Answers why not when it could
 * not; the row is kept then, so nothing that still exists loses its index.
 */
export async function deleteArchive(app: App, row: ArchiveRow): Promise<{ deleted: true } | { kept: string }> {
  const sys = app.db!.asSystem()
  if (row.location && isRemote(row)) {
    const kept = await deleteRemote(app, row)
    if (kept) return { kept }
  }
  if (row.location) {
    const dir = localDir(app, row.location)
    if (!dir && !isRemote(row)) return { kept: `${row.location} is not an archive this installation names; left in place` }
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
  await sys.appBackup.delete({ where: { id: row.id } })
  return { deleted: true }
}

/**
 * The newest archive stays on this disk as the copy a restore reaches first;
 * an UPLOADED archive's local directory lasts until the next backup finishes.
 * A local-only archive is the only copy and goes by retention, not here.
 */
export async function dropWarmCopies(app: App, keepId: string): Promise<void> {
  const sys   = app.db!.asSystem()
  const appId = await requireHubAppId(sys)
  const uploaded = await sys.appBackup.findMany({
    where:  { appId, id: { not: keepId }, status: 'success', destinationId: { not: null }, error: null },
    select: { location: true },
  })
  for (const { location } of uploaded as { location: string | null }[]) {
    const dir = location && localDir(app, location)
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
}

// ─── Retention ────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000

/**
 * Prune by `HubConfig`'s keep-count and age, local and remote apart. Runs after
 * a backup succeeds, so a failed run deletes nothing; the newest successful
 * archive of each group (local, and each destination) is never a candidate. Answers what went and what was kept, and why.
 */
export async function pruneBackups(app: App, now = Date.now()): Promise<{ pruned: string[]; kept: { id: string; why: string }[] }> {
  const sys = app.db!.asSystem()
  const cfg = await sys.hubConfig.findFirst({ where: { id: 'hub' } })
  const out = { pruned: [] as string[], kept: [] as { id: string; why: string }[] }
  if (!cfg) return out

  const rows = (await sys.appBackup.findMany({
    where:  { appId: await requireHubAppId(sys), status: 'success' },
    select: { id: true, status: true, destinationId: true, location: true, error: true, startedAt: true, createdAt: true },
  }) as ArchiveRow[])
    .map(r => ({ ...r, at: Date.parse(r.startedAt ?? r.createdAt!) }))
    .sort((a, b) => b.at - a.at)

  const groups = new Map<string, typeof rows>()
  for (const r of rows) {
    const g = isRemote(r) ? `remote:${r.destinationId}` : 'local'
    groups.set(g, [...(groups.get(g) ?? []), r])
  }

  for (const [group, members] of groups) {
    const remote = group !== 'local'
    const count  = remote ? cfg.backupKeepRemoteCount : cfg.backupKeepLocalCount
    const days   = remote ? cfg.backupKeepRemoteDays  : cfg.backupKeepLocalDays
    // The newest of THIS group is spared, not the newest overall: sparing one
    // row hub-wide let every remote copy age out behind a run of local ones.
    const victims = members.filter((r, i) => i > 0 && (i >= count || (days != null && now - r.at > days * DAY_MS)))
    for (const r of victims) {
      const done = await deleteArchive(app, r)
      if ('deleted' in done) out.pruned.push(r.id)
      else out.kept.push({ id: r.id, why: done.kept })
    }
  }
  return out
}

// ─── Rescan ───────────────────────────────────────────────────────────────

/**
 * List a destination's prefix and give a `found` row to each archive no row
 * names. Only a key this installation's naming could have written counts —
 * `<prefix>/basecamp-<installId>-<stamp>.tar.gz`, or a pre-id
 * `basecamp-<stamp>.tar.gz` -- so a neighbor's object under the same prefix,
 * another hub's included, is left alone and never becomes something retention
 * deletes. A prefix another hub has claimed is refused.
 */
export async function rescanDestination(app: App, destinationId: string): Promise<{ listed: number; found: number; foreign?: number } | { error: string }> {
  const sys  = app.db!.asSystem()
  const dest = await sys.backupDestination.findFirst({ where: { id: destinationId } })
  if (!dest) return { error: `No backup destination '${destinationId}'` }
  if (!dest.secretId) return { error: `Destination '${dest.name}' holds no credential` }

  const appId     = await requireHubAppId(sys)
  const installId = await hubInstallId(sys)
  const claim     = await claimPrefix(app, dest, installId)
  if ('refused' in claim) return { error: claim.refused }
  const known = new Set((await sys.appBackup.findMany({
    where: { appId, destinationId: dest.id }, select: { location: true },
  }) as { location: string | null }[]).map(r => r.location))

  return eachUnknown(app, dest, 'basecamp', known, key => isForeign(key, installId), (o, stamp) => sys.appBackup.create({ data: {
    appId, serverId: null, kind: 'found', status: 'success', destinationId: dest.id, location: o.key,
    sizeBytes: o.size, startedAt: stamp, finishedAt: o.lastModified ? new Date(o.lastModified).toISOString() : null,
    requestedBy: null,
  } }))
}

/** Every `<prefix>/<owner>-<stamp>.tar.gz` no `known` key names, handed to
 *  `add` once each. Any other key under the prefix is a neighbor's. */
async function eachUnknown(
  app: App, dest: Pick<BackupDestination, 'id' | 'name' | 'bucket' | 'prefix'>, owner: string,
  known: Set<string | null>, foreign: (key: string) => boolean, add: (o: ListedObject, stamp: string) => Promise<unknown>,
): Promise<{ listed: number; found: number; foreign?: number } | { error: string }> {
  const send = sendFor(app, dest.id)
  let token: string | undefined, listed = 0, found = 0, others = 0
  do {
    const page = await listObjects(send, dest.bucket, { prefix: keyUnder(dest, `${owner}-`), continuationToken: token })
    if (page.error) return { error: `'${dest.name}' refused the listing (${page.error.kind}${page.error.code ? `, ${page.error.code}` : ''}): ${page.error.message}` }
    for (const o of page.objects!) {
      listed++
      const name  = basename(o.key, '.tar.gz')
      // An app's wrapped database is `<appId>-<stamp>.db.tar.gz` (`FJS-D1724`).
      const stamp = stampOf(owner === 'basecamp' ? name : name.replace(/\.db$/, ''), owner)
      if (!stamp || o.key !== keyUnder(dest, `${name}.tar.gz`) || known.has(o.key)) continue
      if (foreign(o.key)) { others++; continue }
      await add(o, stamp)
      known.add(o.key)
      found++
    }
    token = page.nextToken ?? undefined
  } while (token)
  return others ? { listed, found, foreign: others } : { listed, found }
}

// ─── An app's archives ────────────────────────────────────────────────────
//
// `<prefix>/<appId>-<stamp>.tar.gz` under the app's own backup destination,
// the key `takeAppBackup` mints. A listing carries no digest and a restore
// refuses a row without one (`FJS-D1521`), so a found row is `pending` until
// the hub has read the object through once and recorded its sha256; only
// then is it `success` and restorable (`FJS-D1572`). That digest pins the
// object as first seen — a machine holding a key to the prefix could have
// written it — and no machine is named, because the key names none.

/** Give a `pending` found row to each of the app's archives no row names. */
export async function rescanAppArchives(app: App, appId: string): Promise<{ listed: number; found: number } | { error: string }> {
  const sys    = app.db!.asSystem()
  const target = await sys.app.findFirst({ where: { id: appId } })
  if (!target) return { error: `No app '${appId}'` }
  const dest = await destinationFor(app, target).catch((err: Error) => ({ error: err.message }))
  if (!dest) return { error: `App '${target.name}' names no backup destination` }
  if ('error' in dest) return dest
  if (!dest.secretId) return { error: `Destination '${dest.name}' holds no credential` }

  const known = new Set((await sys.appBackup.findMany({
    where: { appId, destinationId: dest.id }, select: { location: true },
  }) as { location: string | null }[]).map(r => r.location))

  return eachUnknown(app, dest, appId, known, () => false, (o, stamp) => sys.appBackup.create({ data: {
    appId, serverId: null, destinationId: dest.id, kind: 'found', status: 'pending',
    location: o.key, sizeBytes: o.size, startedAt: stamp, requestedBy: null,
  } }))
}

/**
 * Read each of the app's found rows not yet hashed — `pending`, or `failed`
 * by an earlier read — and record its sha256. A read that fails says why on
 * the row and is tried again at the next rescan.
 */
export async function hashFoundArchives(app: App, appId: string): Promise<{ hashed: number; failed: number }> {
  const sys  = app.db!.asSystem()
  const rows = await sys.appBackup.findMany({
    where: { appId, kind: 'found', status: { in: ['pending', 'failed'] } },
  }) as { id: string; destinationId: string | null; location: string | null }[]
  let hashed = 0, failed = 0
  for (const row of rows) {
    const done = await hashObject(app, row).catch((err: Error) => ({ error: err.message }))
    const finishedAt = new Date().toISOString()
    if ('error' in done) {
      await sys.appBackup.update({ where: { id: row.id }, data: { status: 'failed', error: done.error.slice(0, 2000), finishedAt } })
      failed++
    } else {
      await sys.appBackup.update({ where: { id: row.id }, data: { status: 'success', sha256: done.sha256, sizeBytes: done.bytes, error: null, finishedAt } })
      hashed++
    }
  }
  return { hashed, failed }
}

async function hashObject(app: App, row: { destinationId: string | null; location: string | null }): Promise<{ sha256: string; bytes: number } | { error: string }> {
  if (!row.destinationId || !row.location) return { error: 'The row names no object' }
  const dest = await app.db!.asSystem().backupDestination.findFirst({ where: { id: row.destinationId } })
  if (!dest) return { error: `No backup destination '${row.destinationId}'` }
  const res = await fetch(await mintDownload(app, dest, row.location))
  if (!res.ok || !res.body) return { error: `'${dest.name}' answered ${res.status} for ${row.location}` }
  const hasher = new Bun.CryptoHasher('sha256')
  let bytes = 0
  const reader = res.body.getReader()
  for (let r = await reader.read(); !r.done; r = await reader.read()) { hasher.update(r.value); bytes += r.value.byteLength }
  return { sha256: hasher.digest('hex'), bytes }
}
