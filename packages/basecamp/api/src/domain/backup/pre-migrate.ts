// src/domain/backup/pre-migrate.ts
// The copy boot takes before it migrates the hub database (`FJS-3907`).
//
// A migration has no `down`, by ruling — the way back is a copy of the
// database from before it ran, which `litestone migrate apply` takes and
// boot's `apply()` does not. Each migration is its own transaction, so a
// failing one rolls back by itself; the copy is for one that COMMITS and is
// wrong, where the alternative is the last scheduled backup, up to a day old.
//
// Each copy is read with `PRAGMA integrity_check` before it counts, and a
// crash loop keeps the first copy of its run beside the newest ones, since
// every later copy holds what an earlier failed boot already migrated.
//
// A database with nothing applied yet is a first boot and has no rows to
// lose, so it is not copied. A copy that fails stops the boot: migrating
// without it is the thing this file exists to prevent.

import { Database } from 'bun:sqlite'
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { status } from '@frontierjs/litestone/migrations'

/** How many copies are kept. Each is the whole database, on the disk it lives on. */
export const PRE_MIGRATE_KEEP = 3

/** Beside the database rather than in `backups/`, whose `basecamp-<stamp>`
 *  entries the archive rescan and retention read as theirs. */
export const preMigrateDir = (dbPath: string) => join(dirname(dbPath), 'pre-migrate')

/** The copy's path, or null when there was nothing to protect or nothing to apply. */
export function copyBeforeMigrating(
  rawDb:         Database,
  dbPath:        string,
  migrationsDir: string,
  log:           { info(msg: string, meta?: object): void },
): string | null {
  if (!dbPath || dbPath === ':memory:') return null
  const rows    = status(rawDb, migrationsDir)
  const pending = rows.filter(r => r.state === 'pending').map(r => r.file)
  if (!pending.length || !rows.some(r => r.state === 'applied')) return null

  const dir  = preMigrateDir(dbPath)
  mkdirSync(dir, { recursive: true })
  // The swap reads this name: the database it replaces, and an instant it holds
  // against the moment the old container stopped (`FJS-D2044`).
  const dest = join(dir, `${basename(dbPath)}--${new Date().toISOString().replace(/:/g, '-')}.db`)
  try {
    // Bound, never interpolated (Invariant 8). Refuses an existing file, and
    // the name is to the millisecond.
    rawDb.run('VACUUM INTO ?', [dest])
    // The copy holds what the live file holds, so it is no more readable than it.
    chmodSync(dest, statSync(dbPath).mode & 0o777)
    // VACUUM INTO copies a damaged page as readily as a sound one, and a copy
    // nobody has read is a restore that fails when it is wanted.
    const verdict = integrity(dest)
    if (verdict !== 'ok') throw new Error(`PRAGMA integrity_check said: ${verdict}`)
    // A boot that fails and restarts copies again; the newest pending file is
    // the same across that loop, so it names the run `prune` protects.
    writeFileSync(runMark(dest), pending[pending.length - 1])
  } catch (err) {
    rmSync(dest, { force: true })
    rmSync(runMark(dest), { force: true })
    throw new Error(`[basecamp] the copy before migrating failed, so nothing was migrated: ${(err as Error).message} — ${dest}`)
  }
  prune(dir, pending[pending.length - 1])
  log.info('copied the database before migrating', { path: dest, pending })
  return dest
}

const runMark = (copy: string) => `${copy}.run`

function integrity(path: string): string {
  // Not `readonly`: a read-only handle skips the CHECK/NOT NULL half of the
  // verdict, and the copy is a fresh non-WAL file this process just wrote.
  const copy = new Database(path)
  try {
    const rows = copy.query('PRAGMA integrity_check').all() as { integrity_check: string }[]
    return rows.map(r => r.integrity_check).slice(0, 3).join('; ')
  } finally { copy.close() }
}

/** Keeps the newest copies, and the first copy of the run still failing. A
 *  crash loop copies on every boot, and the first is the only one from before
 *  the migration that committed; the newest three would all be after it. */
function prune(dir: string, run: string): void {
  const copies = readdirSync(dir).filter(n => n.endsWith('.db')).sort()
  const first  = copies.find(n => readMark(join(dir, n)) === run)
  const kept   = new Set(copies.slice(-PRE_MIGRATE_KEEP))
  if (first && !kept.has(first)) {
    kept.delete([...kept][0])
    kept.add(first)
  }
  for (const name of copies) {
    if (kept.has(name)) continue
    const path = join(dir, name)
    rmSync(path, { force: true })
    rmSync(runMark(path), { force: true })
  }
}

function readMark(copy: string): string | null {
  try { return readFileSync(runMark(copy), 'utf8') } catch { return null }
}
