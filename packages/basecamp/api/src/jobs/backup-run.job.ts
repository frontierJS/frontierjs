// src/jobs/backup-run.job.ts
// Takes one archive of everything the application keeps. Dispatched as
// `backup:run`.
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
// alone restores every row and none of the trail nobody may lose.
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

import { defineJob }        from '@frontierjs/caravan'
import { Database }         from 'bun:sqlite'
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join }    from 'node:path'
import { runsAsApp }        from './context.ts'
import { jobsDatabasePath } from '../core/db.ts'
import type { BasecampApp } from '../basecamp.types.ts'

/** Bound as a parameter and never interpolated (Invariant 8) — the path is
 *  built here, but the rule is about the shape of the statement rather than
 *  about who supplied the value today. Its own read-only handle, so the file is
 *  copied from what is committed and nothing here can write to it. */
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

/** Writes every database the app keeps into `dest`, a new directory. A declared
 *  directory that does not exist yet is an app that has not written to it, and
 *  is left out; a SQLite file that fails to copy throws, because an archive
 *  missing one of them is not an archive. */
function archiveAll(app: BasecampApp, dest: string): void {
  mkdirSync(dest, { recursive: true })

  const declared = (app.db as unknown as {
    $databases: Record<string, { driver: string; path: string }>
  }).$databases

  for (const [name, { driver, path }] of Object.entries(declared)) {
    if (!path || !existsSync(path)) continue
    if (driver === 'sqlite') vacuumInto(path, join(dest, `${name}.db`))
    else                     cpSync(path, join(dest, name), { recursive: true })
  }

  const jobs = jobsDatabasePath(app.sqlite.filename)
  if (existsSync(jobs)) vacuumInto(jobs, join(dest, 'jobs.db'))
}

/** Where an archive lands — `backups/` beside the live database, so a bind
 *  mount that carries the data volume carries these with it. */
function backupDir(app: BasecampApp): string {
  const live = app.sqlite.filename
  // `:memory:` has no directory. A test env would otherwise write `backups/`
  // into the process CWD, which is somebody's repository.
  if (!live || live === ':memory:') return ''
  return join(dirname(live), 'backups')
}

export async function takeBackup(app: BasecampApp, backupId: string): Promise<void> {
  const log = app.logger.child('backup-run')
  const sys = app.db.asSystem()

  const row = await sys.backup.findFirst({ where: { id: backupId } })
  if (!row) {
    // Pruned between the dispatch and the run. Nothing to do and nothing wrong.
    log.warn('backup row is gone', { id: backupId })
    return
  }

  const startedAt = new Date().toISOString()
  await sys.backup.update({ where: { id: backupId }, data: { status: 'running', startedAt } })

  const finish = async (data: Record<string, unknown>) => {
    const finishedAt = new Date().toISOString()
    await sys.backup.update({
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
    archiveAll(app, path)

    const size = treeSize(path)
    await finish({ status: 'success', sizeBytes: size, location: path, error: null })
    log.info('backup complete', { id: backupId, path, bytes: size })
  } catch (err) {
    const message = (err as Error).message
    await finish({ status: 'failed', error: message, location: null })
    log.error('backup failed', { id: backupId, error: message })
    // Thrown so the queue applies its own backoff — a disk that was full a
    // minute ago may not be.
    throw err
  }
}

// ── The job ───────────────────────────────────────────────────────
// Two attempts. The failures worth retrying are transient (a full disk, a lock
// held by something long-running); a database that cannot be read is not going
// to become readable on the second try, and the row says why either way.

export default defineJob<{ backupId: string }>('backup:run', async (ctx) => {
  // Nobody's work but the app's — a hub action has no workspace, so there is
  // no standing to run as. `backups.create` states `actor: null` to match.
  const { app } = runsAsApp(ctx, 'backup:run')
  await takeBackup(app as BasecampApp, ctx.data.backupId)
}, {
  queue:       'fleet',
  maxAttempts: 2,
  retryDelay:  [30_000],
  // A `VACUUM INTO` of a large database is minutes, not seconds, and an
  // unbounded attempt is how a stalled one becomes invisible. Ten minutes is
  // long enough for a database far bigger than this app will hold.
  timeout:     600_000,
})
