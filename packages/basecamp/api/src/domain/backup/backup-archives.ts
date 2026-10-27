// src/domain/backup/backup-archives.ts
// An archive once it exists: where its local copy is, the one way it is
// deleted, which ones retention lets go, and the rescan that gives a row to
// one found in the bucket with none (`FJS-D1493`).
//
// ─── One delete, derived from the name ────────────────────────────────────
//
// Retention, the warm-copy drop and `backups.remove` all delete through
// `deleteArchive` (`FJS-D1494`). A local directory is `backups/<name>` with
// `<name>` taken from the row's `location` and refused unless it is an archive
// name this file mints — never the stored path, because `location` is a
// column and an unlink of whatever a column says can reach the live database
// beside it. A remote archive goes object first and row second, so a delete
// the vendor refused leaves a row the next prune retries rather than an
// object nothing lists.
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
import { deleteObject, listObjects } from '../../providers/storage/s3.ts'
import type { App }           from '@frontierjs/junction'

/** `basecamp-` and the start time with `:` and `.` flattened to `-`. */
export const ARCHIVE_NAME = /^basecamp-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/

/** The start time an archive's name carries, or null for a name this file did not mint. */
export function stampOf(name: string): string | null {
  const m = name.match(ARCHIVE_NAME)
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : null
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

/** The directory a local archive is, or null when this disk holds none for the
 *  row: a remote one, one that never finished, or one pruned or moved away. */
export function localArchive(app: App, row: ArchiveRow): string | null {
  if (row.status !== 'success' || !row.location || isRemote(row)) return null
  const dir = localDir(app, row.location)
  return dir && existsSync(dir) ? dir : null
}

/**
 * Delete the archive a row names, then the row. Answers why not when it could
 * not; the row is kept then, so nothing that still exists loses its index.
 */
export async function deleteArchive(app: App, row: ArchiveRow): Promise<{ deleted: true } | { kept: string }> {
  const sys = app.db!.asSystem()
  if (row.location && isRemote(row)) {
    const dest = await sys.backupDestination.findFirst({ where: { id: row.destinationId } })
    if (!dest) return { kept: `Destination '${row.destinationId}' is gone, so ${row.location} cannot be reached` }
    if (!('conduit' in app)) return { kept: 'This process has no conduit' }
    const { error } = await deleteObject(sendFor(app, dest.id), dest.bucket, row.location)
    if (error) return { kept: `'${dest.name}' refused the delete (${error.kind}${error.code ? `, ${error.code}` : ''}): ${error.message}` }
  }
  if (row.location) {
    const dir = localDir(app, row.location)
    if (!dir && !isRemote(row)) return { kept: `${row.location} is not an archive this installation names; left in place` }
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
  await sys.backup.delete({ where: { id: row.id } })
  return { deleted: true }
}

/**
 * The newest archive stays on this disk as the copy a restore reaches first;
 * an UPLOADED archive's local directory lasts until the next backup finishes.
 * A local-only archive is the only copy and goes by retention, not here.
 */
export async function dropWarmCopies(app: App, keepId: string): Promise<void> {
  const uploaded = await app.db!.asSystem().backup.findMany({
    where:  { id: { not: keepId }, status: 'success', destinationId: { not: null }, error: null },
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
 * archive is never a candidate. Answers what went and what was kept, and why.
 */
export async function pruneBackups(app: App, now = Date.now()): Promise<{ pruned: string[]; kept: { id: string; why: string }[] }> {
  const sys = app.db!.asSystem()
  const cfg = await sys.hubConfig.findFirst({ where: { id: 'hub' } })
  const out = { pruned: [] as string[], kept: [] as { id: string; why: string }[] }
  if (!cfg) return out

  const rows = (await sys.backup.findMany({
    where:  { status: 'success' },
    select: { id: true, status: true, destinationId: true, location: true, error: true, startedAt: true, createdAt: true },
  }) as ArchiveRow[])
    .map(r => ({ ...r, at: Date.parse(r.startedAt ?? r.createdAt!) }))
    .sort((a, b) => b.at - a.at)
  const newest = rows[0]?.id

  const groups = new Map<string, typeof rows>()
  for (const r of rows) {
    const g = isRemote(r) ? `remote:${r.destinationId}` : 'local'
    groups.set(g, [...(groups.get(g) ?? []), r])
  }

  for (const [group, members] of groups) {
    const remote = group !== 'local'
    const count  = remote ? cfg.backupKeepRemoteCount : cfg.backupKeepLocalCount
    const days   = remote ? cfg.backupKeepRemoteDays  : cfg.backupKeepLocalDays
    const victims = members.filter((r, i) => r.id !== newest && (i >= count || (days != null && now - r.at > days * DAY_MS)))
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
 * `<prefix>/basecamp-<stamp>.tar.gz` — so a neighbor's object under the same
 * prefix is left alone and never becomes something retention deletes.
 */
export async function rescanDestination(app: App, destinationId: string): Promise<{ listed: number; found: number } | { error: string }> {
  const sys  = app.db!.asSystem()
  const dest = await sys.backupDestination.findFirst({ where: { id: destinationId } })
  if (!dest) return { error: `No backup destination '${destinationId}'` }
  if (!dest.secretId) return { error: `Destination '${dest.name}' holds no credential` }

  const send = sendFor(app, dest.id)
  const known = new Set((await sys.backup.findMany({
    where: { destinationId: dest.id }, select: { location: true },
  }) as { location: string | null }[]).map(r => r.location))

  let token: string | undefined, listed = 0, found = 0
  do {
    const page = await listObjects(send, dest.bucket, { prefix: keyUnder(dest, 'basecamp-'), continuationToken: token })
    if (page.error) return { error: `'${dest.name}' refused the listing (${page.error.kind}${page.error.code ? `, ${page.error.code}` : ''}): ${page.error.message}` }
    for (const o of page.objects!) {
      listed++
      const name    = basename(o.key, '.tar.gz')
      const stamp   = stampOf(name)
      if (!stamp || o.key !== keyUnder(dest, `${name}.tar.gz`) || known.has(o.key)) continue
      await sys.backup.create({ data: {
        kind: 'found', status: 'success', destinationId: dest.id, location: o.key,
        sizeBytes: o.size, startedAt: stamp, finishedAt: o.lastModified ? new Date(o.lastModified).toISOString() : null,
        requestedBy: null,
      } })
      known.add(o.key)
      found++
    }
    token = page.nextToken ?? undefined
  } while (token)
  return { listed, found }
}
