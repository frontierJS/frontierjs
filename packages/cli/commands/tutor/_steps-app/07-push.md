---
title: 07-push
description: The schema change reaches the database, and the app is restarted through it
---

## Into the database

`fli db:push` diffs the seed against the database that exists and applies the
difference. Nothing generated a migration file and nothing asked you to name
one — the schema **is** the migration.

Then the API is restarted. That is not tidiness: an app reads `db/schema.lite`
once, at `createClient`, so a process started before the model existed goes on
serving the shape it booted with and refuses a write to `notes` for a model the
file plainly declares.

What is asserted here is the **table**, read out of `db/app.db` directly. A
command that exits 0 and a table that exists are two different claims, and only
the second one is worth having.

```js
if (!await narrate($)) return

$.config.__step = 7

if (!needs($, ['appDir'], { from: '02-new' })) return

$.exec({ command: `${$.fli} db:push`, cwd: $.config.appDir })

const db = join($.config.appDir, 'db', 'app.db')

if (!await must($, probe.sqliteRow({
  db,
  sql:    "select name from sqlite_master where type = 'table' and name = 'note'",
  expect: (rows) => rows.length === 1,
  name:   'the note table exists in db/app.db',
}), {
  likely:    'db:push refused the change — a required column with no default blocks, and says so',
  reproduce: `cd ${$.config.appDir} && fli db:push`,
})) return

const api = await restartApi($)

if (!await must($, api.up, {
  likely:    'the API did not come back after the schema change — its output is below',
  reproduce: `cd ${$.config.appDir} && PORT=${$.config.apiPort} bun run start`,
  detail:    serverLog(api),
})) return

// The service is mounted from the file `fli scaffold` wrote, autoloaded at boot
// — so a 404 here would mean the restart missed it rather than that the table
// is absent, which is why this is asked separately from the row above.
if (!await must($, probe.httpStatus({
  url:     apiUrl($, '/notes'),
  retries: 10,
  name:    'GET /api/notes is served, and public',
}), {
  likely:    'the notes service did not load — check .tutor/api.log',
  reproduce: `curl -sS -i ${apiUrl($, '/notes')}`,
})) return
```
