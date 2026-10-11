// backup.js — how a live SQLite file is copied, and the only place that answers it.
//
// Two callers hold different handles: the client's `$backup`, which copies a
// connection out of its own registry, and `litestone migrate apply --backup`,
// which copies a raw Database the CLI opened before any client exists. A second
// implementation would be a second answer to "is this copy safe while the
// database is being written", which is the whole question a backup asks.

import { writeFileSync, statSync } from '#host'

// Returns the size of the written file. `vacuum` compacts on the way out —
// slower, and it refuses to overwrite an existing destination. On a device the
// file write is refused by name (`HOST_UNAVAILABLE`) before any bytes move.
export async function backupSqliteTo(rawDb, destPath, { vacuum = false } = {}) {
  if (!vacuum && typeof rawDb.serialize === 'function') {
    writeFileSync(destPath, rawDb.serialize())
  } else {
    rawDb.run(`PRAGMA wal_checkpoint(TRUNCATE)`)
    rawDb.prepare(`VACUUM INTO ?`).run(destPath)
  }
  return statSync(destPath).size
}
