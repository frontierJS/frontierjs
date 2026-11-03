// src/domain/backup/pre-migrate.ts
// The copy boot takes before it migrates the hub database (`FJS-3907`).
//
// A migration has no `down`, by ruling — the way back is a copy of the
// database from before it ran, which `litestone migrate apply` takes and
// boot's `apply()` does not. Each migration is its own transaction, so a
// failing one rolls back by itself; the copy is for one that COMMITS and is
// wrong, where the alternative is the last scheduled backup, up to a day old.
//
// A database with nothing applied yet is a first boot and has no rows to
// lose, so it is not copied. A copy that fails stops the boot: migrating
// without it is the thing this file exists to prevent.

import type { Database } from 'bun:sqlite'
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
  const dest = join(dir, `${new Date().toISOString().replace(/:/g, '-')}.db`)
  try {
    // Bound, never interpolated (Invariant 8). Refuses an existing file, and
    // the name is to the millisecond.
    rawDb.run('VACUUM INTO ?', [dest])
    // The copy holds what the live file holds, so it is no more readable than it.
    chmodSync(dest, statSync(dbPath).mode & 0o777)
  } catch (err) {
    rmSync(dest, { force: true })
    throw new Error(`[basecamp] the copy before migrating failed, so nothing was migrated: ${(err as Error).message} — ${dest}`)
  }
  prune(dir)
  log.info('copied the database before migrating', { path: dest, pending })
  return dest
}

function prune(dir: string): void {
  const copies = readdirSync(dir).filter(n => n.endsWith('.db')).sort()
  for (const old of copies.slice(0, -PRE_MIGRATE_KEEP)) {
    const path = join(dir, old)
    if (existsSync(path)) rmSync(path)
  }
}
