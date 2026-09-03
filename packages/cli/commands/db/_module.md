---
namespace: db
description: Litestone database management — schema, migrations, studio, JSON Schema
defaults:
  flags:
    test:
      defaultValue: false
---

<script>
import { resolve } from 'path'
import { existsSync, readFileSync } from 'fs'

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

// ─── resolveSeeder ───────────────────────────────────────────────────────────
// Where is this app's seeder, and how is it run?
//
// There is no single convention and there are three competing ones, so this
// ASKS the app rather than adding a fourth:
//
//   1. litestone.config.js `seeder:`  — litestone's own declaration, and the
//      only one the Data realm actually owns.
//   2. the package.json script         — `db:seed` or `seed`. An app that has
//      one has already answered the question, flags and all.
//   3. a probe of the known locations  — db/seed.js, db/seed.ts,
//      db/seeders/seed.{ts,js}, db/seeders/DatabaseSeeder.js.
//
// This command used to hardcode `db/seeders/seed.ts` alone, which is a path
// NOTHING in the FrontierJS repo produces: basecamp's is db/seed.js declared as
// a `db:seed` script, litestone's own default is seeders/DatabaseSeeder.js, and
// the example app has no seeder at all. So `fli db:seed` reported "Seeder not
// found" for an app that seeds perfectly well with its own script.
//
// Returns { command, describe } or null.

const resolveSeeder = (context, { force = false } = {}) => {
  const root   = context.paths.root
  const dbDir  = context.paths.db
  const extra  = force ? ' --force' : ''

  // 1 · litestone.config.js — the declaration wins over any guess.
  const cfgPath = resolve(dbDir, 'litestone.config.js')
  if (existsSync(cfgPath)) {
    try {
      const declared = readFileSync(cfgPath, 'utf8').match(/\bseeder\s*:\s*['"`]([^'"`]+)['"`]/)
      if (declared) {
        const abs = resolve(dbDir, declared[1])
        if (existsSync(abs))
          return { command: `cd ${root} && bun run ${abs}${extra}`, describe: `litestone.config.js seeder: ${declared[1]}` }
      }
    } catch { /* unparseable — fall through to the app's own script */ }
  }

  // 2 · the app's own script. It may do more than run a file (reset, migrate,
  // set an env var), which is exactly why it is preferred over a path.
  try {
    const scripts = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).scripts ?? {}
    const name    = ['db:seed', 'seed'].find(n => scripts[n])
    // A script that calls THIS command would loop forever. Skip it and probe.
    if (name && !/\bfli\s+db[:-]seed\b/.test(scripts[name])) {
      const runner = existsSync(resolve(root, 'bun.lock')) || existsSync(resolve(root, 'bun.lockb'))
        || existsSync(resolve(root, '..', '..', 'bun.lock'))
        ? 'bun' : 'npm'
      return { command: `cd ${root} && ${runner} run ${name}${extra ? ' -- --force' : ''}`, describe: `package.json script: ${name}` }
    }
  } catch { /* no manifest — probe */ }

  // 3 · the known locations, in the order they are likely.
  for (const rel of ['seed.js', 'seed.ts', 'seeders/seed.ts', 'seeders/seed.js', 'seeders/DatabaseSeeder.js']) {
    const abs = resolve(dbDir, rel)
    if (existsSync(abs))
      return { command: `cd ${root} && bun run ${abs}${extra}`, describe: `db/${rel}` }
  }

  return null
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
  if (!existsSync(full)) {
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
fli db:explain     — what a .lite word is (aliased `fli explain`; needs no schema)
fli db:advise      — what this schema says wrong, and what it never said at all
fli db:seed        — run db/seeders/seed.ts
fli db:jsonschema  — generate JSON Schema from schema.lite → db/.json/schema.json
fli db:backup      — back up the database file
fli db             — open an interactive SQLite REPL
```

## Environment variables

- `DB_DIR`  — override the `db/` directory name (default: `db`)
- `DB_FILE` — override the database filename (default: `development.db`)

## Test database

Every `db:` command that reads or writes data accepts `--test` to target
`test.db` instead of `development.db`.
