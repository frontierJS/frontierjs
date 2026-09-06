---
title: 01-app
description: An app that can notify, and the one model the package expects
---

## An app, and a table to write into

This lesson needs `@frontierjs/notifications` in the app. If the workspace
already holds one that has it, it is reused; otherwise the app is built here
with the package included:

```console
fli new <app> --auth --with notifications
fli scaffold Note --fields "title:string body:text done:boolean"
```

One model goes into `db/schema.lite` with it, because an in-app notification is
a ROW and the row has to live somewhere. `--with` runs `fli notifications:install`
for you; on an app that already exists you run it yourself:

```console
bun add @frontierjs/notifications
fli notifications:install
```

**The package ships the model and the command appends it** — it is not typed out
here or in the README, so there is one copy of the text and `fli check`'s
`package-model-drift` grades yours against the file it came from. It is
appended rather than imported because the model is the APP's: `userId`'s type
follows your own user key, and everything you add next — a relation, a tenant
key, a column a bell menu wants — happens here.

```text
model Notification {
  id          Int       @id
  userId      String              // String, not Int — auth issues uuid ids
  type        String              // the notification's stable name
  data        Json                // whatever its formatter built
  contextType String?             // 'Note', 'Order' — a loose reference
  contextId   Int?                //   with no foreign key, so a deleted row
  readAt      DateTime?           //   does not cascade into somebody's bell menu
  createdAt   DateTime  @default(now())

  @@check("contextType IN ('Note')")
  @@gate("0.8.4.8")
  @@allow('read',   userId == auth().id)
  @@allow('update', userId == auth().id)
}
```

Read the gate: **read is open and the policy scopes it**, create is SYSTEM,
update is USER — you may mark your own as read — and delete is SYSTEM. Create
is `8` rather than `9` on purpose. `9` is LOCKED, a wall `asSystem()` does not
pass either, and the writer here IS `asSystem()`: a `9` in the create slot would
stop the package from ever writing a row.

The `@@check` is there because `fli check` asks for it by name. `contextType`
says what `contextId` points at, and a pair like that has no foreign key by
design — so nothing refuses a value naming nothing, not a migration and not
`asSystem()`. The one column that CAN be constrained is, and this app has one
kind of context. An app whose set genuinely grows with every model baselines
that rule instead, which is the other half of the same answer.

```js
if (!await narrate(context)) return

context.config.__step = 1

const dir = appDir(context)

const pkgJson = join(dir, 'package.json')
const hasPkg  = (() => {
  try { return Boolean(JSON.parse(readFileSync(pkgJson, 'utf8')).dependencies?.['@frontierjs/notifications']) }
  catch { return false }
})()

// Reuse is by the FILE and by the DEPENDENCY, the same test tutor:jobs makes.
// An app an earlier lesson left has no notifications in it, and adding the
// package afterwards is a `bun link` dance under --source local that the
// scaffold already does correctly — so the app is rebuilt rather than patched,
// and the message says so rather than a directory quietly disappearing.
const built = existsSync(join(dir, 'db', 'schema.lite')) && hasPkg

if (!built) {
  if (existsSync(dir)) {
    log.info(existsSync(join(dir, 'db', 'schema.lite'))
      ? `the app here cannot notify — rebuilding ${dir} with @frontierjs/notifications`
      : `building an app that can notify — ${dir}`)
    rmSync(dir, { recursive: true, force: true })
  }

  context.exec({
    command: `${context.fli} new ${context.config.app} --yes --auth --with notifications --no-git --no-deploy --source ${context.config.source}`,
    cwd:     context.config.ws.dir,
  })
  context.exec({
    command: `${context.fli} scaffold Note --fields "title:string body:text done:boolean"`,
    cwd:     dir,
  })
}

context.config.appDir = dir

// The model arrives with the scaffold — `fli new --with notifications` runs
// `fli notifications:install`, which appends the file the package ships. What
// this step adds is the one line the package cannot write for an app: which
// models contextType may name. `fli check`'s `polymorphic-subject` asks for it
// by name, and the answer is the app's because the set is.
const schema = schemaFile(context)

if (!await must(context, probe.fileContains({
  path:   schema,
  needle: /^model Notification \{/m,
  name:   'the scaffold installed the model the package needs',
}), {
  likely:    'the install step did not run — `fli notifications:install` appends it',
  reproduce: `cd ${dir} && fli notifications:install`,
})) return

const text = readFileSync(schema, 'utf8')
if (!/@@check\("contextType/.test(text)) {
  writeFileSync(schema, text.replace(
    /(model Notification \{[\s\S]*?)\n\}/m,
    `$1\n\n  // This app's answer to \`polymorphic-subject\`: a pair like this has no\n` +
    `  // foreign key by design, so the one column that CAN be constrained is.\n` +
    `  @@check("contextType IN ('Note')")\n}`,
  ), 'utf8')
}

pushSchema(context)

if (!await must(context, probe.fileContains({
  path:   pkgJson,
  needle: '@frontierjs/notifications',
  name:   'the app depends on @frontierjs/notifications',
}), {
  likely:    'the scaffold did not finish — its output is above',
  reproduce: `cd ${context.config.ws.dir} && fli new ${context.config.app} --yes --auth --with notifications`,
})) return

// Asked of the DATABASE rather than of the schema file: a model that parses and
// a table that exists are two different facts, and only the second one can be
// written to.
if (!await must(context, probe.sqliteRow({
  db:     join(dir, 'db', 'app.db'),
  sql:    "select name from sqlite_master where type = 'table' and name = 'notification'",
  expect: (rows) => rows.length === 1,
  name:   'there is a notification table to write rows into',
}), {
  likely:    'db:push ran but built nothing — its output is above',
  reproduce: `cd ${dir} && fli db:push`,
})) return

remember(context, '01-app', { appDir: dir })
```
