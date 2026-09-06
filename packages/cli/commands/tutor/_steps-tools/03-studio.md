---
title: 03-studio
description: The database, as it actually is
---

## `fli db:studio` — what is really in there

```console
fli db:studio      # http://localhost:{{studioPort}}
```

**Open this when a screen has nothing on it.** An empty grid has three causes
that look identical from a browser — the query is wrong, a row policy filtered
everything out, or there is genuinely nothing there — and only the third is not
a bug. The studio answers which, in one look, because it reads the database
directly and is subject to none of your app's rules.

It also answers the question underneath that one: **which file am I even
looking at?** A relative database path resolves against the directory the
command was typed in, so a tool run from the wrong place opens a NEW, EMPTY
database and reports on it, cheerfully, with nothing missing and nothing to
complain about. The studio names the file it opened, and this step checks that
the name it gives is the file the app writes to.

The other panel worth knowing about is **drift**: has `db/schema.lite` changed
since the running app read it, and are there migrations that have not been
applied. That is the answer to *why is my new column not there* before you go
looking for it in the code.

A row is written over HTTP first, so the count that follows is one this lesson
really put there.

```js
if (!await narrate(context)) return

context.config.__step = 3

if (!needs(context, ['appDir'], { from: '01-app' })) return

const app = context.config.appDir
await ensureApi(context)

// Note creates at USER(4), so there has to be somebody. A fresh address per
// run: an app reused from an earlier lesson already has the other one.
const who = `studio-${Date.now()}@frontier.invalid`
const registered = await registerAccount(context, { email: who, password: 'correct horse battery', name: 'Ada' })
if (!await must(context, registered, {
  likely: 'the API is up but /auth/register is not answering — is auth installed?',
})) return

context.config.userToken = registered.json.token

const made = await createNote(context, 'written before the studio was opened')
if (!await must(context, made, {
  likely: 'the note was refused — the response is above',
})) return

const studio = await startServer(context, {
  name: 'studio',
  // --no-open, because a studio started by a script otherwise opens a browser
  // window on whatever machine is running it.
  argv: fliArgv('db:studio', '--port', String(context.config.studioPort), '--no-open'),
  cwd:  app,
  port: context.config.studioPort,
  path: '/api/info',
})
if (!await must(context, studio.up, {
  likely:    `something already holds ${context.config.studioPort}`,
  reproduce: `cd ${app} && fli db:studio --port ${context.config.studioPort}`,
})) return

const at = (path) => `http://127.0.0.1:${context.config.studioPort}${path}`

// The file, and the row. Asked together because either one alone is
// satisfiable by a studio pointed at the wrong database: an empty one has a
// path, and a stale one has rows.
if (!await must(context, await probe.httpJson({
  url:      at('/api/info'),
  expect:   (j) => j.dbPath === join(app, 'db', 'app.db') && j.counts?.Note >= 1,
  describe: `dbPath ${join(app, 'db', 'app.db')} and at least one Note`,
  name:     'the studio is on the app’s own database, and the row is in it',
}), {
  likely: 'a dbPath that is not this is a tool started from another directory — the path is resolved against the CWD',
})) return

// Drift is the panel that answers *why is my new column not there*, and it is
// asked in both directions — a panel that always says *no drift* is the same
// green as one that works.
const drift = (want, name) => probe.httpJson({
  url:      at('/api/drift'),
  expect:   (j) => j.file?.changed === want,
  describe: `the schema file reported as ${want ? 'moved' : 'unmoved'}`,
  name,
  retries:  4,
})

if (!await must(context, await drift(false, 'no drift, on an app nobody has edited'), {
  likely: 'db/schema.lite has been edited since the process read it — restart the API, or run fli db:push',
})) return

// The edit that causes it is a COMMENT, so nothing about the database changes
// and reverting is exact. What the panel compares is the file against what this
// process read at boot — which is the real thing behind *I added a column and
// the app cannot see it*: the running process is on the old schema.
const schema = schemaFile(context)
const before = readFileSync(schema, 'utf8')
writeFileSync(schema, `${before}\n// edited, and not yet pushed\n`, 'utf8')

const moved = await drift(true, 'and drift the moment the file moves')

writeFileSync(schema, before, 'utf8')

if (!await must(context, moved, {
  likely: 'the panel compares the file with what the process read at boot — a false here means it is comparing nothing',
})) return

if (!await must(context, await drift(false, 'and back, with the edit taken out'), {
  likely: `the edit was reverted — if this still reports drift, compare ${schema} with git`,
})) return

log.info('')
log.info(`  the studio is at http://localhost:${context.config.studioPort} — the Note table has a row in it`)
log.info('')

remember(context, '03-studio', {})
```
