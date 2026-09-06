---
title: outbox:install
description: Install the transactional outbox — imports the OutboxMessage model and prints the relay wiring
alias: outbox-install
examples:
  - fli outbox:install
  - fli outbox:install --db audit
  - fli outbox:install --dry
flags:
  db:
    char: d
    type: string
    description: Database block the outbox table lives in (must exist in schema.lite)
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

// ─── Where the schema comes from ──────────────────────────────────────────────
//
// `@frontierjs/junction` ships `db/outbox.lite` and this imports it BY NAME.
// Nothing is copied, which is the difference from `fli auth:install`: auth
// writes out `model User` because the app owns it and adds columns to it, and
// imports the three @@gate("8") models. Every model here is machinery — the
// app reads the table when something did not arrive and writes it never — so
// there is nothing to hand over and an upgrade reaches an installed app.
//
// `into <db>` is what retargets it, so there is no string rewrite here either:
// the nearest `into` beats the `@@db(main)` written in the file.

const PKG = '@frontierjs/junction'

// `core/app-schema.js` owns *is this shipped file installed HERE* — one owner,
// because this used to resolve with `createRequire(...).resolve(specifier)` and
// bun answers that from its global install CACHE for a package the app does not
// have. See the note on `shippedFile`.
const { shippedFile } = await import(resolve(global.fliRoot, 'core/app-schema.js'))

const resolveFromApp = (root, subpath) =>
  shippedFile(root, PKG, `.${subpath.slice(PKG.length)}`)?.file ?? null

const schemaBlock = (db) => `
// ─── Outbox — installed by fli outbox:install ────────────────────────────────
//
// One row per effect that must survive a crash. \`ctx.enqueue(job, payload)\`
// writes it inside the call's own transaction, so the intent is recorded if and
// only if the write it belongs to committed; the relay hands it to app.jobs and
// marks it delivered.
//
// Imported rather than pasted: OutboxMessage is @@gate("8") framework
// machinery, so it changes when @frontierjs/junction does and not when this app
// does. The specifier resolves through node, so the package must be installed
// for this schema to parse.${db === 'main' ? '' : `\n// \`into ${db}\` is what lands it in your ${db} database.`}

import "${PKG}/outbox.lite"${db === 'main' ? '' : ` into ${db}`}
`

const wiringHint = `
// ─── Add to api/src/server.ts ─────────────────────────────────────────────────

import { outbox }       from '@frontierjs/junction/outbox'
import { createCaravan } from '@frontierjs/caravan'

app.configure(createCaravan({ jobsDir: './src/jobs' }))  // the outbox needs a queue
app.configure(outbox())

// Then, in a service that declares \`transactional:\`
//
//   async create(ctx) {
//     const order = await ctx.locals.db.order.create({ data: ctx.data })
//     await ctx.enqueue('order.shipped', { orderId: order.id })
//     return order
//   }
//
// The row commits with the write or rolls back with it. A handler named
// 'order.shipped' has to exist, or the row can never be delivered.
`
</script>

Installs the transactional outbox into the current project.

`ctx.afterCommit(fn)` runs an effect only if the call succeeded and the
transaction committed. It buys nothing against a **crash**: the process dies
between the commit and the callback and the effect is simply never done, with
nothing anywhere recording that it was owed.

The outbox is the durable half. `ctx.enqueue(job, payload)` writes a row inside
the call's own transaction, so the intent is recorded if and only if the write
it belongs to committed, and a relay delivers it to `app.jobs` afterwards.

The row has to be in this app's own database and can be nowhere else: Litestone
opens one connection per declared `database` block, so a row in a second one
survives the rollback that was supposed to take it. That is also why the queue
stays its own file, and why delivery is **at-least-once** — a handler must be
idempotent.

What it does:
- Appends `import "@frontierjs/junction/outbox.lite"` to `db/schema.lite`
- Pushes the schema so the table exists
- Prints the two lines to add to `api/src/server.ts`

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
const importsOutbox = /^[ \t]*import\s+["']@frontierjs\/junction\/outbox\.lite["']/m.test(schemaContents)
const declaresModel = /^\s*model\s+OutboxMessage\b/m.test(schemaContents)

if (importsOutbox || declaresModel) {
  log.warn('OutboxMessage already present — skipping schema injection')
  log.info('Wire the relay with app.configure(outbox()) — it needs app.jobs, so configure caravan too')
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

if (!resolveFromApp(context.paths.root, `${PKG}/outbox.lite`)) {
  log.error(`Could not resolve ${PKG}/outbox.lite from ${context.paths.root}`)
  log.info(`Install it first: bun add ${PKG}`)
  log.info('A version that does not ship db/outbox.lite has no outbox to install.')
  return
}

echo('')
log.info('Installing the transactional outbox...')
echo('')

// ─── 3. Append the import ─────────────────────────────────────────────────────
//
// An APPEND, not an insertion. `import` is legal anywhere at the top level and
// parseFile merges imported models ahead of local ones regardless of where the
// line sits, so nothing here has to parse the app's own file to find a spot.

const importLine = `import "${PKG}/outbox.lite"` + (flag.db === 'main' ? '' : ` into ${flag.db}`)

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
log.info('Add this to your server:')
echo(wiringHint)
```
