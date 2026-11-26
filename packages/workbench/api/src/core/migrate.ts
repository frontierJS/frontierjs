// api/src/core/migrate.ts
// Every database the schema declares is brought to db/migrations/<name>/ at
// boot, each copied first (FJS-4627), before the client opens: a client on a
// fresh file creates every table and the first migration then collides. Without
// this a watched API ran fifteen hours on a chat.db missing a column, and the
// only trace was dead jobs.

import { existsSync }      from 'node:fs'
import { join }            from 'node:path'
import { openWalDatabase } from '@frontierjs/litestone/engine'
import { apply, copyBeforeMigrating, declaredDatabasePaths } from '@frontierjs/litestone/migrations'

const log = { info: (msg: string, meta?: object) => console.log(`[workbench] ${msg}`, meta ?? '') }

/** Applies each database's pending migrations; a copy or a migration that fails stops the boot. */
export async function migrateAtBoot (schemaPath: string, migrationsRoot: string): Promise<void> {
  for (const { name, path } of declaredDatabasePaths(schemaPath, { resolveFrom: 'schema' })) {
    const dir = join(migrationsRoot, name)
    if (!existsSync(dir)) continue
    // Two boots at once (the API and a worker, or CI's snapshot generators side
    // by side) both write the tracking table; a handle with no busy wait fails
    // the second with "database is locked".
    const raw = openWalDatabase(path, { create: true })
    try {
      copyBeforeMigrating(raw, path, dir, log)
      const r = await apply(raw, dir)
      if (r.unmatched || r.error) throw new Error(`[workbench] ${r.message ?? r.error} — db/migrations/${name}`)
      if (r.applied.length) log.info(`applied ${r.applied.length} migration(s) to ${name}`, { files: r.applied.map(a => a.file) })
    } finally { raw.close() }
  }
}
