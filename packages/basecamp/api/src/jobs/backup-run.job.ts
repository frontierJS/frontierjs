// src/jobs/backup-run.job.ts
// Takes one archive of the application database. Dispatched as `backup:run`.
//
// The handler takes a backup id and nothing else — the row is the queue's
// payload, so a retry acts on the current state rather than on a snapshot taken
// when the button was pressed.
//
// ─── Why VACUUM INTO and not a file copy ──────────────────────────────────
//
// The database is live and in WAL mode: copying the file while a write is in
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
import { statSync, mkdirSync } from 'node:fs'
import { dirname, join }    from 'node:path'
import { runsAsApp }        from './context.ts'
import type { BasecampApp } from '../basecamp.types.ts'

/** Where an archive lands — `backups/` beside the live database, so a bind
 *  mount that carries the data volume carries these with it. */
function backupDir(app: BasecampApp): string {
  const live = app.sqlite.filename
  // `:memory:` has no directory. A test env would otherwise write `backups/`
  // into the process CWD, which is somebody's repository.
  if (!live || live === ':memory:') return ''
  return join(dirname(live), 'backups')
}

async function takeBackup(app: BasecampApp, backupId: string): Promise<void> {
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
  const path  = join(dir, `basecamp-${stamp}.db`)

  try {
    mkdirSync(dir, { recursive: true })

    // Bound as a parameter and never interpolated (Invariant 8) — the path is
    // built here, but the rule is about the shape of the statement rather than
    // about who supplied the value today.
    app.sqlite.run('VACUUM INTO ?', [path])

    const { size } = statSync(path)
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
