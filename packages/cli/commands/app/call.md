---
title: app:call
description: Call one service method as somebody, through the hook pipeline, and print the answer as JSON — no server
alias: call
examples:
  - fli call orders.find '{"status":"paid","$limit":5}' --as alex@shop.test --tenant flagship
  - fli call orders.get 12 --as sam@shop.test --tenant flagship
  - fli call orders.patch 12 '{"note":"late"}' --as alex@shop.test --tenant flagship
  - fli call notes.find --app api/src/app.ts --as ann@x.test
args:
  -
    name: method
    description: <service>.<method> — a CRUD verb or a custom method
  -
    name: idOrJson
    description: An id, or a JSON query or body — a word that parses as JSON is that value
  -
    name: json
    description: The JSON body, after an id
flags:
  as:
    char: a
    type: string
    description: Call as this person — an email, username, name or id in the @@auth model, or Model:value
    defaultValue: ''
  tenant:
    char: t
    type: string
    description: Whose database, under tenancy { strategy database }
    defaultValue: ''
  app:
    type: string
    description: The app module — without it, the one the committed surface.snapshot.md names
    defaultValue: ''
  export:
    type: string
    description: Which export of the module is the app, when it has more than one
    defaultValue: ''
---

```js
const { callArgv } = await import(new URL('file://' + global.fliRoot + '/core/app-entry.js'))
const { spawnSync } = await import('node:child_process')

const plan = callArgv(context.paths.root, {
  app:        flag.app,
  exportName: flag.export,
  words:      [arg.method, arg.idOrJson, arg.json],
  as:         flag.as,
  tenant:     flag.tenant,
})
if (plan.error) {
  log.error(plan.error)
  process.exitCode = 1
  return
}

// argv, never a shell: a JSON body holds quotes and `$`, and the entry flags
// come out of a committed file. The child's own stdout is the answer, so it is
// inherited rather than captured and re-printed.
const run = spawnSync('bun', plan.argv, { cwd: plan.cwd, stdio: 'inherit' })
if (run.error?.code === 'ENOENT') {
  log.error('bun not found — junction is Bun-only, so calling the app needs bun on PATH')
  process.exitCode = 1
  return
}
process.exitCode = run.status ?? 1
```

## What it is

The call a request makes, without the request. The app boots in this process,
the method runs inside `app.runAs` as the person `--as` names, and the answer
comes out of the same hooks, gate and envelope an HTTP call gets:

```
$ fli call orders.find '{"status":"paid","$limit":2}' --as alex@shop.test --tenant flagship
  Standing: alex@shop.test (User 06fc3ec1-…) · tenant flagship
{ "object": "orders", "data": [ … ], "total": 2, "limit": 2, "offset": 0, "hasMore": false, … }
```

It replaces the loop of starting a dev server, logging in by curl, copying a
token, sleeping and killing the server — and `sqlite3` against the file, which
answers with every gate off.

The answer is JSON on stdout and nothing else is, so `| jq` reads it. The
standing, the build's logs and a refusal go to stderr. A refusal prints the
status HTTP would have sent (`Forbidden (403): …`) and exits 1.

## Who it runs as

| | |
| --- | --- |
| `--as <who>` | a row of the `@@auth` model (or `User`), found by email, username, name or id, in the tenant the call runs in |
| *(nothing)* | no principal at all — `STRANGER(0)`, which a gated method refuses |

With no `--as` the call is **not** the app's system principal. `runAs(null)`
means *the app itself*, and a stranger's call run that way passed every gate.

## What the boot skips

The app boots with `_startOnce()` (`FJS-D551`): plugins register and boot,
hooks compile, routes mount, and no plugin's `work()` runs. So a call starts
no Caravan worker, no cron and no poll, and cannot claim a job the serving
process was owed.

## Which app

`--app` names the module, resolved from where you run the command, and the call
runs from the app root, which is where a scaffolded app's own scripts run.
Without it, the entry and its flags come from the header of the committed
`surface.snapshot.md` and run from that file's directory, the way the
`snapshots` CI phase reruns it. Neither is found by guessing a path, because a
guess that is wrong describes an app nobody serves.

## Arguments

A word that parses as JSON is that value, and anything else is a string: `12`
is an id, `'{"a":1}'` is a bag, `abc-123` a string id without double quoting.
A CRUD verb takes them in its own order — `find [query]`, `get <id>`,
`create <data>`, `patch <id> <data>`. A custom method takes an id and a body,
and a lone JSON object is read as the body.

`$limit`, `$offset`, `$orderBy` and `$select` in a query travel as directives,
and a `$` key the directive table does not name is refused by name. The
hook-bypass twins (`_find`, `_patch`) are refused: a call from outside that
skips the pipeline is the `sqlite3` this replaces.

**Needs bun.** Junction is Bun-only, and this runs the app's own `junction call`, resolved the way its imports resolve it.
