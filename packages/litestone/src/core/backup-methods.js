// backup-methods.js — the client's backup surface over its own connection
// registry: `$walStatus`, `$backupStamp`, `$clearBackupStamp` and `$backup`.
// The copy itself, and the stamp's storage, are backup.js, which the CLI also
// calls with a raw Database it opened before any client exists; this file is
// only what a client does with the handles it already holds.

import { resolve, mkdirSync } from '#host'
import { backupSqliteTo, readBackupStamp, clearBackupStamp } from './backup.js'

export function makeBackupMethods(/** @type {any} */ { dbRegistry }) {
  function $walStatus() {
    // PRAGMA wal_checkpoint=NOOP (SQLite 3.51.0+) reports WAL frame counts
    // without triggering a checkpoint. Safe to call at any time, even under load.
    // Returns: { busy, frames, checkpointed }
    //   busy:         true if a checkpoint is blocked by active readers
    //   frames:       total WAL frames since last full checkpoint
    //   checkpointed: frames already checkpointed
    // For multi-DB schemas returns { dbName: { busy, frames, checkpointed }, ... }
    const result = {}
    for (const [name, conn] of Object.entries(dbRegistry)) {
      if (!conn.rawWriteDb) continue
      try {
        const row = conn.rawWriteDb.query('PRAGMA wal_checkpoint(NOOP)').get()
        result[name] = row
          ? { busy: row.busy === 1, frames: row.log, checkpointed: row.checkpointed }
          : null
      } catch { result[name] = null }
    }
    const keys = Object.keys(result)
    return keys.length === 1 ? result[keys[0]] : result
  }

  // `{ takenAt }` when a database this client opened came out of a backup
  // (`FJS-D665`), otherwise null. A restore rewinds every row written after
  // `takenAt`, so a row older than it that records an unfinished handoff to
  // the outside world may already have been handed off. The latest stamp
  // across the client's databases answers, since a restore puts back the set.
  function $backupStamp() {
    let latest = null
    for (const conn of Object.values(dbRegistry)) {
      if (conn.driver !== 'sqlite' || !conn.rawWriteDb) continue
      const stamp = readBackupStamp(conn.rawWriteDb)
      if (stamp && (!latest || stamp.takenAt > latest.takenAt)) latest = stamp
    }
    return latest
  }

  // The operator has settled what the stamp was holding: the database is
  // nobody's backup any more, and a row older than the stamp is ordinary.
  function $clearBackupStamp() {
    for (const conn of Object.values(dbRegistry)) {
      if (conn.driver === 'sqlite' && conn.rawWriteDb) clearBackupStamp(conn.rawWriteDb)
    }
  }

  // `only` narrows to named databases. Without it a caller wanting ONE database
  // out of several had to open a client per database — and `createClient({ db })`
  // names MAIN, so each of those clients backed up main under a different
  // database's name. Asking here is the only way to ask truthfully.
  async function $backup(destPath, { vacuum = false, only = null } = {}) {
    const abs   = resolve(destPath)
    const names = only == null ? null : (Array.isArray(only) ? only : [only])

    // SQLite-only — backs up all open SQLite connections.
    // For a full backup including JSONL/trail databases, use: litestone backup
    const sqliteDbs = Object.entries(dbRegistry)
      .filter(([name, conn]) => conn.driver === 'sqlite' && conn.rawWriteDb && (!names || names.includes(name)))

    if (!sqliteDbs.length) {
      const declared = Object.entries(dbRegistry).filter(([, c]) => c.driver === 'sqlite').map(([n]) => n)
      throw new Error(
        names
          ? `$backup: no SQLite database named ${names.join(', ')}. Declared: ${declared.join(', ') || 'none'}`
          : `$backup: this client has no SQLite database to back up`
      )
    }

    const backupOne = (db, dest) => backupSqliteTo(db, dest, { vacuum })

    if (sqliteDbs.length > 1) {
      mkdirSync(abs, { recursive: true })
      const results = {}
      for (const [name, conn] of sqliteDbs) {
        const dest = resolve(abs, `${name}.db`)
        results[name] = { driver: 'sqlite', path: dest, size: await backupOne(conn.rawWriteDb, dest), vacuumed: vacuum }
      }
      return results
    }

    // sqliteDbs[0], not the closure's rawWriteDb — with `only` they differ, and
    // the closure's is always main.
    const size = await backupOne(sqliteDbs[0][1].rawWriteDb, abs)
    return { path: abs, size, vacuumed: vacuum }
  }

  return { $walStatus, $backupStamp, $clearBackupStamp, $backup }
}
