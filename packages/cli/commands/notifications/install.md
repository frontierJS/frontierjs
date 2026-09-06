---
title: notifications:install
description: Install @frontierjs/notifications — appends the Notification model and prints the wiring
alias: notifications-install
examples:
  - fli notifications:install
  - fli notifications:install --db main
  - fli notifications:install --dry
flags:
  db:
    char: d
    type: string
    description: Database block the notifications table lives in (must exist in schema.lite)
    defaultValue: main
  dry:
    type: boolean
    description: Show what would be done without writing anything
    defaultValue: false
  push:
    type: boolean
    description: Push the schema to the database afterwards
    defaultValue: true
---

<script>
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve }                                  from 'path'

// ─── Copied, not imported, and the difference is the point ───────────────────
//
// `@frontierjs/notifications` ships `db/notification.lite` and this writes its
// bytes into the app's own schema, the way `fli auth:install` writes out
// `model User` — because the app OWNS this model. It relates userId to its own
// User, it adds the columns its bell menu wants, and it answers
// `polymorphic-subject` for contextType, which this package cannot answer for
// it. `fli outbox:install` imports by name instead, and that is right there:
// OutboxMessage is @@gate("8") machinery an app never writes.
//
// What the copy costs is drift, which is why the package exports the file at
// all: `fli check`'s `package-model-drift` compares the copy against it and
// names a column this package writes that the app's copy does not have.

const PKG = '@frontierjs/notifications'

// One owner for *is this shipped file installed HERE*. Never
// `createRequire(...).resolve()` — bun answers that from its global install
// cache for a package the app does not have, and what lands in the schema is
// then whatever version was in the cache.
const { shippedFile } = await import(resolve(global.fliRoot, 'core/app-schema.js'))

// A shipped `.lite` parses standalone, so it spells `@@db(main)` out rather
// than carrying a placeholder. Anchored to the line: the file discusses the
// attribute in its own header, and a bare substring replace rewrites that prose
// too.
const retargetDb = (source, db) =>
  db === 'main' ? source : source.replace(/^([ \t]*)@@db\(main\)/gm, `$1@@db(${db})`)

const MARK = '// ─── Notifications — installed by fli notifications:install ─'

const wiringHint = `
  import { mailerPlugin }        from '@frontierjs/junction'
  import { notificationsPlugin } from '@frontierjs/notifications'

  // The mailer FIRST — the plugin declares requires: ['mailer'] when its email
  // transport uses one, so the wrong order is refused at startup rather than at
  // the first send.
  app.configure(mailerPlugin(createSmtpMailer({ ... })))

  app.configure(notificationsPlugin({
    db,
    transports: { email: { mailer: 'default' } },
  }))
`
</script>

Installs the one model `@frontierjs/notifications` requires.

It is **appended** rather than imported: `Notification` is the app's model, not
the package's. The package writes rows to it through `asSystem()` and reads
none, while the app relates it to its own `User`, puts it on a screen and
decides what `contextType` may hold — and `userId`'s type follows the app's own
user key, which an `extend model` could not change.

The text has one origin all the same. `fli check`'s `package-model-drift` reads
the file this copied from and names a column that has since diverged.

```js
const schemaPath = resolve(context.paths.db, 'schema.lite')

if (!existsSync(schemaPath)) {
  log.error(`schema.lite not found at ${schemaPath}`)
  log.info('Run this from an app root — `fli new` writes one.')
  context.config.abort = true
  return
}

const schemaContents = readFileSync(schemaPath, 'utf8')

// Two layouts count as installed: this block, and a model somebody wrote by
// hand before there was a command. Missing either injects a second declaration
// of a model the app already has, which fails the whole parse.
if (schemaContents.includes(MARK) || /^\s*model\s+Notification\b/m.test(schemaContents)) {
  log.warn('Notification is already in this schema — nothing to append')
  echo(wiringHint)
  return
}

// The named block has to exist, `main` included: exempting it is what let an
// install inject models naming a database nobody declared, which fails at
// createClient rather than here.
if (!new RegExp(`database\\s+${flag.db}\\s*\\{`).test(schemaContents)) {
  log.error(`Database block '${flag.db}' not found in schema.lite`)
  log.info(`Add a 'database ${flag.db} { path ... }' block first, or pass --db <name>`)
  context.config.abort = true
  return
}

// Installed HERE, and read through the package's own exports map.
const shipped = shippedFile(context.paths.root, PKG, './schema.lite')

if (!shipped) {
  log.error(`Could not read ${PKG}/schema.lite from ${context.paths.root}`)
  log.info(`Install it first: bun add ${PKG}`)
  log.info('A version that ships no db/notification.lite has no model to install.')
  context.config.abort = true
  return
}

const block = [
  '',
  MARK + '───────────────────',
  '//',
  `// Copied from ${PKG}/db/notification.lite. It is yours to grow — a relation`,
  '// back to your own User, a tenant key, whatever a screen needs — and',
  "// `fli check`'s package-model-drift compares what stayed against the file it",
  '// came from.',
  '',
  retargetDb(shipped.text, flag.db).trim(),
  '',
].join('\n')

if (flag.dry) {
  log.dry(`Would append model Notification (${shipped.file}) to ${schemaPath}`)
  echo(wiringHint)
  return
}

writeFileSync(schemaPath, schemaContents.replace(/\s*$/, '\n') + block, 'utf8')
log.success('Appended model Notification to schema.lite')

if (flag.push) {
  log.info('Pushing schema to database...')
  try {
    context.exec({ command: `${context.fli} db:push`, cwd: context.paths.root })
    log.success('Schema pushed')
  } catch (e) {
    log.warn(`db:push failed: ${e.message} — run it yourself once the schema parses`)
  }
}

echo('')
log.info('Now wire it — the mailer first:')
echo(wiringHint)
log.info('A notification is a FILE, and the file names it:')
log.info('  api/src/notifications/OrderPaid.notification.ts  →  type "OrderPaid"')
echo('')
```
