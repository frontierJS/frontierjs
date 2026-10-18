// core/schema-apply.js — how an install command lands the schema it just edited.
//
// `litestone db push` writes tables and no file, so in an app with a migration
// history the pushed table lives in app.db and nowhere else: the next
// `db:migrate` refuses ("in db, not in schema") and a deploy, which replays
// files, never creates it. The push also applies the WHOLE pending schema, not
// the one table the install added. An app with history gets `migrate dev`,
// which writes the file and applies it; an app with none has nothing to fall
// behind, and `db push` stays what it was there (FJS-1797).

import { existsSync, readdirSync } from 'node:fs'
import { join }                    from 'node:path'

// Any `.sql` under db/migrations/<database>/ counts, whatever the database is named.
export function hasMigrationHistory(dbDir) {
  const dir = join(dbDir, 'migrations')
  if (!existsSync(dir)) return false
  return readdirSync(dir, { withFileTypes: true }).some(e =>
    e.isDirectory() && readdirSync(join(dir, e.name)).some(f => f.endsWith('.sql')))
}

// The litestone argv (after the binary), the sentence that names it, and the
// `fli` verb a generator tells a person to run for the same step.
export function schemaApplyStep(dbDir, label) {
  if (hasMigrationHistory(dbDir)) {
    return {
      kind:  'migrate',
      command: 'fli db:migrate',
      argv:  `migrate dev ${label} --schema db/schema.lite`,
      dry:   `litestone migrate dev ${label}`,
      done:  `Migration db/migrations/*_${label}.sql written and applied`,
    }
  }
  return {
    kind:  'push',
    command: 'fli db:push',
    argv:  'db push --schema db/schema.lite',
    dry:   'litestone db push',
    done:  'Schema pushed',
  }
}
