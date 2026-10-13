// backup.js — how a live SQLite file is copied, and the only place that answers it.
//
// Two callers hold different handles: the client's `$backup`, which copies a
// connection out of its own registry, and `litestone migrate apply --backup`,
// which copies a raw Database the CLI opened before any client exists. A second
// implementation would be a second answer to "is this copy safe while the
// database is being written", which is the whole question a backup asks.

import { writeFileSync, statSync } from '#host'
import { openDatabase } from './engine.js'

/** Litestone's own key/value table, inside every database it has written to. */
export const META_TABLE = '_litestone_meta'

const TAKEN_AT_KEY = 'backup.takenAt'

// Returns the size of the written file. `vacuum` compacts on the way out —
// slower, and it refuses to overwrite an existing destination. On a device the
// file write is refused by name (`HOST_UNAVAILABLE`) before any bytes move.
//
// The copy is stamped with the instant it holds (`FJS-D665`). A database put
// back from it has rewound every row written since — an outbox row's delivered
// mark among them — and the stamp is how a reader of the restored file learns
// which of its rows the world may have moved past.
export async function backupSqliteTo(rawDb, destPath, { vacuum = false } = {}) {
  const takenAt = new Date().toISOString()
  if (!vacuum && typeof rawDb.serialize === 'function') {
    writeFileSync(destPath, rawDb.serialize())
  } else {
    rawDb.run(`PRAGMA wal_checkpoint(TRUNCATE)`)
    rawDb.prepare(`VACUUM INTO ?`).run(destPath)
  }
  const copy = openDatabase(destPath)
  try { writeBackupStamp(copy, takenAt) } finally { copy.close() }
  return statSync(destPath).size
}

/** `{ takenAt }` when this database came out of a backup, otherwise null. */
export function readBackupStamp(rawDb) {
  try {
    const takenAt = rawDb.query(`SELECT value FROM "${META_TABLE}" WHERE key = ?`).get(TAKEN_AT_KEY)?.value
    return takenAt ? { takenAt } : null
  } catch { return null }   // no meta table: never written by a backup
}

export function writeBackupStamp(rawDb, takenAt) {
  rawDb.run(`CREATE TABLE IF NOT EXISTS "${META_TABLE}" (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
  rawDb.run(
    `INSERT INTO "${META_TABLE}" (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    TAKEN_AT_KEY, takenAt
  )
}

export function clearBackupStamp(rawDb) {
  try { rawDb.run(`DELETE FROM "${META_TABLE}" WHERE key = ?`, TAKEN_AT_KEY) }
  catch { /* no meta table: nothing stamped */ }
}
