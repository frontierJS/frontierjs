---
title: backfill:install
description: Install the backfill runner — imports the BackfillRun model and prints the wiring
alias: backfill-install
examples:
  - fli backfill:install
  - fli backfill:install --db ops
  - fli backfill:install --dry
flags:
  db:
    char: d
    type: string
    description: Database block the run table lives in (must exist in schema.lite)
    defaultValue: main
  dry:
    type: boolean
    description: Show what would be done without writing anything
    defaultValue: false
---

<script>
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve }                                  from 'path'
import { createRequire }                            from 'node:module'
import { pathToFileURL }                            from 'node:url'

// `@frontierjs/junction` ships `db/backfill.lite` and this imports it BY NAME.
// Nothing is copied, for the reason `fli outbox:install` gives: BackfillRun is
// @@gate("8") machinery an app reads and never writes, so it changes when the
// package does and an upgrade reaches an installed app.

const PKG = '@frontierjs/junction'

// `core/app-schema.js` owns *is this shipped file installed HERE*. This used to
// resolve with `createRequire(...).resolve(specifier)`, which bun answers from
// its global install CACHE for a package the app does not have — see the note
// on `shippedFile`.
const { shippedFile } = await import(resolve(global.fliRoot, 'core/app-schema.js'))

const resolveFromApp = (root, subpath) =>
  shippedFile(root, PKG, `.${subpath.slice(PKG.length)}`)?.file ?? null

const schemaBlock = (db) => `
// ─── Backfill — installed by fli backfill:install ────────────────────────────
//
// One row per backfill, holding how far it got. The middle step of
// expand → backfill → contract: filling a column for every existing row is not
// a migration, and this is the checkpoint that makes it resumable.
//
// Imported rather than pasted: BackfillRun is @@gate("8") framework machinery.
// The specifier resolves through node, so the package must be installed for
// this schema to parse.${db === 'main' ? '' : `\n// \`into ${db}\` is what lands it in your ${db} database.`}

import "${PKG}/backfill.lite"${db === 'main' ? '' : ` into ${db}`}
`

const wiringHint = `
// ─── api/src/backfills/order-shipped-at.ts ───────────────────────────────────

import { defineBackfill } from '@frontierjs/junction'

export default defineBackfill({
  name:  'order-shipped-at',
  model: 'Order',
  field: 'shippedAt',
  fill:  (row) => new Date(row.createdAt),
})

// ─── api/src/app.ts ──────────────────────────────────────────────────────────

import { backfills }       from '@frontierjs/junction/backfill'
import { createCaravan }   from '@frontierjs/caravan'
import orderShippedAt      from './backfills/order-shipped-at.ts'

app.configure(createCaravan({ jobsDir: './src/jobs' }))  // a chunk runs as a job
app.configure(backfills([orderShippedAt]))

// It starts itself: boot queues the first chunk of anything unfinished, and each
// chunk queues the next after a gap proportional to what it just cost. Ask
// app.backfills.status() for how far it got.
`
</script>

Installs the backfill runner into the current project.

`fli release:check` refuses a contract on a required column and hands back
*expand → backfill → contract*. The first and third steps are deploys. The
middle one is the only step that takes hours and the only one that can fail
halfway, and it is not a migration: a migration is a schema change applied once
inside a transaction, and that definition is worth keeping.

A backfill is a **cursor over one table**. The row this installs is the
checkpoint; Caravan runs each chunk. Resumable, chunked, and re-runnable without
doubling its work — which comes from the predicate rather than the cursor: a
chunk re-reads *the column is still null*, so a row an interrupted chunk already
filled is skipped whatever position was saved.

What it does:
- Appends `import "@frontierjs/junction/backfill.lite"` to `db/schema.lite`
- Pushes the schema so the table exists
- Prints a declaration and the two lines to add to `api/src/app.ts`

```js
const schemaPath = resolve(context.paths.db, 'schema.lite')

// ─── 1. Preflight ─────────────────────────────────────────────────────────────

if (!existsSync(schemaPath)) {
  log.error(`schema.lite not found at ${schemaPath}`)
  return
}

const schemaContents = readFileSync(schemaPath, 'utf8')

// Two layouts count as installed: imported by name, and pasted in by hand.
// Missing either injects a second declaration over an app that already has one.
const importsIt   = /^[ \t]*import\s+["']@frontierjs\/junction\/backfill\.lite["']/m.test(schemaContents)
const declaresIt  = /^\s*model\s+BackfillRun\b/m.test(schemaContents)

if (importsIt || declaresIt) {
  log.warn('BackfillRun already present — skipping schema injection')
  log.info('Wire it with app.configure(backfills([...])) — a chunk runs as a job, so configure caravan too')
  return
}

// The named block has to exist. `main` is checked like any other: exempting it
// is what let auth inject models naming a database nobody declared, which fails
// the whole parse at createClient rather than here.
if (!new RegExp(`database\\s+${flag.db}\\s*\\{`).test(schemaContents)) {
  log.error(`Database block '${flag.db}' not found in schema.lite`)
  log.info(`Add a 'database ${flag.db} { path ... }' block first, or pass --db <name>`)
  return
}

// ─── 2. The package has to be installed ───────────────────────────────────────
//
// A RESOLVE rather than a package.json read: a declared dependency nobody
// installed fails at parse in exactly the same way, and the schema is about to
// import this specifier by name.

if (!resolveFromApp(context.paths.root, `${PKG}/backfill.lite`)) {
  log.error(`Could not resolve ${PKG}/backfill.lite from ${context.paths.root}`)
  log.info(`Install it first: bun add ${PKG}`)
  log.info('A version that does not ship db/backfill.lite has no runner to install.')
  return
}

echo('')
log.info('Installing the backfill runner...')
echo('')

// ─── 3. Append the import ─────────────────────────────────────────────────────
//
// An APPEND, not an insertion. `import` is legal anywhere at the top level and
// parseFile merges imported models ahead of local ones regardless of where the
// line sits, so nothing here has to parse the app's own file to find a spot.

const importLine = `import "${PKG}/backfill.lite"` + (flag.db === 'main' ? '' : ` into ${flag.db}`)

if (flag.dry) {
  log.dry(`Would append ${importLine} to ${schemaPath}`)
} else {
  writeFileSync(schemaPath, schemaContents + schemaBlock(flag.db), 'utf8')
  log.success(`Appended ${importLine} to schema.lite`)
}

// ─── 4. Push the schema ───────────────────────────────────────────────────────

if (flag.dry) {
  log.dry('Would run: litestone db push')
} else {
  log.info('Pushing schema to database...')
  context.exec({ command: `cd ${context.paths.root} && bun run litestone db push --schema db/schema.lite` })
  log.success('Schema pushed')
}

// ─── 5. What to wire ──────────────────────────────────────────────────────────

echo('')
log.info('Declare a backfill, and hand it to the app:')
echo(wiringHint)
```
