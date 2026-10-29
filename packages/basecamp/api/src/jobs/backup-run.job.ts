// src/jobs/backup-run.job.ts
// Takes one archive of everything the application keeps. Dispatched as
// `backup:run`. The row is an `AppBackup` on the hub App (`FJS-D1606`), its
// `serverId` the box the hub is placed on.
//
// The handler takes a backup id and nothing else — the row is the queue's
// payload, so a retry acts on the current state rather than on a snapshot taken
// when the button was pressed.
//
// ─── What is in an archive ────────────────────────────────────────────────
//
// A directory, one entry per thing the app persists: every SQLite database the
// schema declares (`<name>.db`), every directory-driven one (the `audit` trail,
// copied as `audit/`), and Caravan's queue (`jobs.db`), which no schema names.
// The declared set is read from the client's own `$databases`, so a database
// added to the schema is archived without an edit here. The same set is what
// `litestone backup` copies in a deploy's pre-swap step. An archive of main
// alone restores every row and none of the trail nobody may lose. Last comes
// `manifest.json`, what a restore checks first (`domain/backup/archive-manifest.ts`).
//
// ─── Why VACUUM INTO and not a file copy ──────────────────────────────────
//
// The databases are live and in WAL mode: copying a file while a write is in
// flight produces an archive that is missing whatever was still in the -wal, and
// nothing about the copy says so. `VACUUM INTO` is SQLite's own answer — it
// takes a read transaction, writes a fully consistent database to a new path,
// and compacts it on the way past. One statement, no locking of the live
// database against writers, and the result is a file `sqlite3` opens.
//
// ─── runsAsApp, and the dispatch says so ──────────────────────────────────
//
// A person asks for a manual backup, so `runsAsCaller` looks right and is not:
// it refuses without a TENANT, and a hub action has no workspace. There is no
// membership to re-resolve and no scoped parent read to confine anything, so
// the app owns this work and who asked is a column on the row (`FJS-384`).
//
// ─── Leaving the box ──────────────────────────────────────────────────────
//
// A row naming a destination tars the archive and sends it as ONE `putObject`
// to `<prefix>/basecamp-<stamp>.tar.gz`, which becomes `location`; the local
// directory stays until the next backup finishes. A failed or refused upload
// keeps the local directory, finishes `success` and says why in `error` — the
// archive exists, it is only on the disk it was meant to leave,
// and a `failed` row would read as no archive at all. After a success the
// retention in `backup-archives.ts` runs. The connector has no
// multipart and holds the body in memory, so above `MAX_UPLOAD_BYTES` the job
// refuses rather than discovering the limit at the vendor or in the heap.

import { defineJob }        from '@frontierjs/caravan'
import { Database }         from 'bun:sqlite'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { runsAsApp }        from './context.ts'
import { jobsDatabasePath } from '../core/db.ts'
import { keyUnder, sendFor } from '../providers/storage/index.ts'
import { backupDir, dropWarmCopies, pruneBackups } from '../domain/backup/backup-archives.ts'
import { putObject }        from '../providers/storage/s3.ts'
import { writeManifest }    from '../domain/backup/archive-manifest.ts'
import { hostServer, requireHubAppId } from '../domain/host/host-machine.ts'
import type { App }         from '@frontierjs/junction'
import type { AppBackup, RunStatus } from '../../../db/schema.d.ts'

/** One PUT, held in memory. B2 and S3 cap a single PUT at 5 GB; this is lower
 *  because the whole body is a buffer in the API process. */
export const MAX_UPLOAD_BYTES = 1024 ** 3

/** Only for Caravan's queue, which no schema names and `app.db.$backup` cannot
 *  reach. Bound as a parameter and never interpolated (Invariant 8). Its own
 *  read-only handle, so the file is copied from what is committed and nothing
 *  here can write to it. */
function vacuumInto(source: string, dest: string): void {
  const raw = new Database(source, { readonly: true })
  try { raw.run('VACUUM INTO ?', [dest]) } finally { raw.close() }
}

/** Bytes of everything under `dir`. */
function treeSize(dir: string): number {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile())
    .reduce((n, e) => n + statSync(join(e.parentPath, e.name)).size, 0)
}

/** Files under `dir`. */
function treeFiles(dir: string): number {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).length
}

/** Writes every database the app keeps into `dest`, a new directory. A declared
 *  directory that does not exist yet is an app that has not written to it, and
 *  is left out; a SQLite file that fails to copy throws, because an archive
 *  missing one of them is not an archive. */
async function archiveAll(app: App, dest: string, takenAt: string): Promise<void> {
  mkdirSync(dest, { recursive: true })

  const declared = (app.db as unknown as {
    $databases: Record<string, { driver: string; path: string }>
  }).$databases

  for (const [name, { driver, path }] of Object.entries(declared)) {
    if (!path || !existsSync(path)) continue
    if (driver === 'sqlite') {
      // The client's own backup, which stamps the copy as one (`FJS-D665`).
      await (app.db as unknown as {
        $backup(dest: string, opts: { vacuum: boolean; only: string }): Promise<unknown>
      }).$backup(join(dest, `${name}.db`), { vacuum: true, only: name })
    } else cpSync(path, join(dest, name), { recursive: true })
  }

  const jobs = jobsDatabasePath(app.sqlite.filename)
  if (existsSync(jobs)) vacuumInto(jobs, join(dest, 'jobs.db'))

  await writeManifest(dest, takenAt)
}

/** `<dir>.tar.gz` beside `dir`, with `dir`'s own name as its one top entry. */
async function tarball(dir: string): Promise<string> {
  const out  = `${dir}.tar.gz`
  const proc = Bun.spawn(['tar', '-czf', out, '-C', dirname(dir), basename(dir)], { stderr: 'pipe' })
  const code = await proc.exited
  if (code !== 0) throw new Error(`tar exited ${code}: ${(await new Response(proc.stderr).text()).trim()}`)
  return out
}

/**
 * Send the archive at `dir` to the row's destination. Answers the object key,
 * or the warning that goes in `error` with the local copy left in place.
 */
async function upload(app: App, destinationId: string, dir: string): Promise<{ key: string; bytes: number } | { warning: string }> {
  const kept = `The archive is on this disk at ${dir}.`
  const dest = await app.db!.asSystem().backupDestination.findFirst({ where: { id: destinationId } })
  if (!dest) return { warning: `Destination '${destinationId}' is gone; nothing was uploaded. ${kept}` }
  if (!('conduit' in app)) return { warning: `This process has no conduit; nothing was uploaded. ${kept}` }

  let tar: string | null = null
  try {
    tar = await tarball(dir)
    const bytes = statSync(tar).size
    if (bytes > MAX_UPLOAD_BYTES) return {
      warning: `The archive is ${bytes} bytes, over the ${MAX_UPLOAD_BYTES}-byte single-upload limit; nothing was uploaded. ${kept}`,
    }
    const key = keyUnder(dest, `${basename(dir)}.tar.gz`)
    const { error } = await putObject(sendFor(app, destinationId), dest.bucket, key,
      new Uint8Array(await Bun.file(tar).arrayBuffer()), { contentType: 'application/gzip' })
    if (error) return { warning: `Upload to '${dest.name}' failed (${error.kind}${error.code ? `, ${error.code}` : ''}): ${error.message}. ${kept}` }
    return { key, bytes }
  } catch (err) {
    return { warning: `Upload to '${dest.name}' failed: ${(err as Error).message}. ${kept}` }
  } finally {
    // The tarball is a transfer copy; the directory beside it is the local archive.
    if (tar) rmSync(tar, { force: true })
  }
}

export async function takeBackup(app: App, backupId: string): Promise<void> {
  const log = app.logger.child('backup-run')
  const sys = app.db!.asSystem()

  const row = await sys.appBackup.findFirst({ where: { id: backupId } })
  if (!row) {
    // Pruned between the dispatch and the run. Nothing to do and nothing wrong.
    log.warn('backup row is gone', { id: backupId })
    return
  }

  const startedAt = new Date().toISOString()
  await sys.appBackup.update({ where: { id: backupId }, data: { status: 'running', startedAt } })

  const finish = async (data: Record<string, unknown>) => {
    const finishedAt = new Date().toISOString()
    await sys.appBackup.update({
      where: { id: backupId },
      data:  { ...data, finishedAt, durationMs: Date.parse(finishedAt) - Date.parse(startedAt) },
    })
  }

  const dir = backupDir(app)
  if (!dir) {
    await finish({ status: 'failed', error: 'This process has no database file to archive' })
    return
  }

  // `:` is legal in a POSIX filename and unusable on Windows, and an archive is
  // a file somebody downloads. The timestamp is flattened rather than trusted.
  const stamp = startedAt.replace(/[:.]/g, '-')
  const path  = join(dir, `basecamp-${stamp}`)

  try {
    await archiveAll(app, path, startedAt)
    const fileCount = treeFiles(path)

    if (row.destinationId) {
      const sent = await upload(app, row.destinationId, path)
      if ('key' in sent) {
        await finish({ status: 'success', sizeBytes: sent.bytes, fileCount, location: sent.key, error: null })
        log.info('backup uploaded', { id: backupId, destination_id: row.destinationId, key: sent.key, bytes: sent.bytes })
      } else {
        await finish({ status: 'success', sizeBytes: treeSize(path), fileCount, location: path, error: sent.warning })
        log.warn('backup kept local', { id: backupId, destination_id: row.destinationId, warning: sent.warning })
      }
    } else {
      const size = treeSize(path)
      await finish({ status: 'success', sizeBytes: size, fileCount, location: path, error: null })
      log.info('backup complete', { id: backupId, path, bytes: size })
    }
  } catch (err) {
    const message = (err as Error).message
    await finish({ status: 'failed', error: message, location: null })
    log.error('backup failed', { id: backupId, error: message })
    // Thrown so the queue applies its own backoff — a disk that was full a
    // minute ago may not be.
    throw err
  }

  // Outside the try: the archive is written and its row says so, and a prune
  // that throws must not rewrite that row as `failed`. A failed run never
  // reaches here, so it prunes nothing.
  try {
    await dropWarmCopies(app, backupId)
    const { pruned, kept } = await pruneBackups(app)
    if (pruned.length) log.info('backups pruned', { id: backupId, pruned })
    for (const k of kept) log.warn('backup kept past retention', { id: k.id, why: k.why })
  } catch (err) { log.warn('retention did not run', { id: backupId, error: String(err) }) }
}

// ── The job ───────────────────────────────────────────────────────
// Two attempts. The failures worth retrying are transient (a full disk, a lock
// held by something long-running); a database that cannot be read is not going
// to become readable on the second try, and the row says why either way.

const backupRun = defineJob<{ backupId: string }>({
  name:        'backup:run',
  queue:       'fleet',
  maxAttempts: 2,
  retryDelay:  [30_000],
  // A `VACUUM INTO` of a large database is minutes, not seconds, and an
  // unbounded attempt is how a stalled one becomes invisible. Ten minutes is
  // long enough for a database far bigger than this app will hold.
  timeout:     600_000,
  handler: async (ctx) => {
    // Nobody's work but the app's — a hub action has no workspace, so there is
    // no standing to run as. `backups.take` states `actor: null` to match.
    const { app } = runsAsApp(ctx, 'backup:run')
    await takeBackup(app, ctx.data.backupId)
  },
})

export default backupRun

// ── Asking for one ────────────────────────────────────────────────

/** Terminal states — anything else is still in flight. */
export const SETTLED: RunStatus[] = ['success', 'failed', 'timeout']

/**
 * Write a `pending` row on the hub App and dispatch the run — the one door a
 * person (`backups.take`) and the hub App's `backupCron` (`job-schedule.ts`)
 * both come through. Throws `requireHubAppId`'s refusal before `useHost` made
 * the row.
 *
 * Answers the archive still in flight instead, when there is one. Two
 * concurrent `VACUUM INTO`s are not a corruption risk, but they are two
 * archives of the same bytes a second apart, and the second doubles how long
 * the first takes.
 */
export async function queueBackup(
  app:  App,
  data: { kind: 'manual' | 'scheduled'; destinationId: string | null; requestedBy: string | null },
): Promise<{ backup: AppBackup } | { inFlight: AppBackup }> {
  const sys   = app.db!.asSystem()
  const appId = await requireHubAppId(sys)

  const inFlight = await sys.appBackup.findFirst({
    where: { appId, status: { notIn: SETTLED } }, orderBy: { createdAt: 'desc' },
  })
  if (inFlight) return { inFlight }

  // At system: a hub action has no workspace, and the hub App and the
  // destination are rows of one a sysadmin may not belong to. Who asked is
  // the column.
  const serverId = (await hostServer(sys))?.id ?? null
  const backup = await sys.appBackup.create({ data: { ...data, appId, serverId, status: 'pending' } })

  // `actor: null` — the handler declares `runsAsApp` (see the header), and an
  // inherited principal is one it would then refuse.
  await app.jobs.dispatch(backupRun, { backupId: backup.id }, { queue: 'fleet', priority: 5, actor: null })

  return { backup }
}
