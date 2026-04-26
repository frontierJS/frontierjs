---
namespace: db
description: Litestone database management — schema, migrations, studio, JSON Schema
defaults:
  flags:
    test:
      defaultValue: false
---

<script>

// ─── resolveDb ───────────────────────────────────────────────────────────────
// Returns the db file path for the current environment.
// Reads DB_FILE from env to override the default (development.db / test.db).
//
// Usage in any db command:
//   const { dbPath, dbFile, dbName, full, schema } = resolveDb(context, flag)

const resolveDb = (context, flag) => {
  const dbPath  = context.paths.db
  const dbName  = flag.test ? 'test' : 'development'
  const dbFile  = process.env.DB_FILE || `${dbName}.db`
  const schema  = resolve(dbPath, 'schema.lite')
  return { dbPath, dbFile, dbName, full: `${dbPath}/${dbFile}`, schema }
}

// ─── requireSchema ────────────────────────────────────────────────────────────
// Checks schema.lite exists before running a command.

const requireSchema = (context) => {
  const schemaPath = resolve(context.paths.db, 'schema.lite')
  if (!existsSync(schemaPath)) {
    context.log.error(`schema.lite not found at ${schemaPath}`)
    context.log.info('Create a schema.lite file in your db/ directory to get started')
    return false
  }
  return true
}

// ─── requireDb ───────────────────────────────────────────────────────────────
// Checks the db file exists before running a command.

const requireDb = (context, flag) => {
  const { full } = resolveDb(context, flag)
  let exists = false
  try { exists = require('fs').existsSync(full) } catch {
    exists = true // assume ok, command will fail naturally if file missing
  }
  if (!exists) {
    context.log.error(`Database not found: ${full}`)
    context.log.info('Run: fli db:push  to create it from schema.lite')
    return false
  }
  return true
}

// ─── litestone ───────────────────────────────────────────────────────────────
// Returns the litestone CLI invocation for the current project.

const litestone = (context) => {
  return `cd ${context.paths.root} && bunx litestone`
}
</script>

## Setup

The `db:` commands manage a **Litestone** SQLite database defined in `db/schema.lite`.

```
fli db:push        — apply schema.lite to the database directly (no migration file)
fli db:migrate     — create + apply a migration file from schema changes
fli db:status      — show pending migrations
fli db:studio      — open Litestone Studio in the browser
fli db:seed        — run db/seeders/seed.ts
fli db:jsonschema  — generate JSON Schema from schema.lite → db/schema.json
fli db:backup      — back up the database file
fli db             — open an interactive SQLite REPL
```

## Environment variables

- `DB_DIR`  — override the `db/` directory name (default: `db`)
- `DB_FILE` — override the database filename (default: `development.db`)

## Test database

Every `db:` command that reads or writes data accepts `--test` to target
`test.db` instead of `development.db`.
