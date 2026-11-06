---
title: db:import
description: Replace the local dev database with production's — through Basecamp when BASECAMP_APP_ID is set, over ssh otherwise
alias: db-import
examples:
  - fli db:import
  - fli db:import --dev
  - fli db:import --dry
flags:
  basecamp:
    type: string
    description: The Basecamp holding the App, by its name in basecamps.json (default the only one; with several and none named, refused with the names) — Basecamp only
    defaultValue: ''
  dev:
    type: boolean
    description: Import from the dev server instead of production — with BASECAMP_APP_ID set, the project's development App
    defaultValue: false
---

With `BASECAMP_APP_ID` set, the project's production App's newest bucket
archive (`--dev`: its development App's) is fetched as
`fli db:download` fetches it, and each database in it replaces the local one
of its name — `production.db` as `development.db`. With no archive in a bucket
it refuses rather than falling back to ssh (`FJS-D1717`). Otherwise
`PROD_SERVER` backs its `production.db` up in place, the copy is fetched by
scp and restored as `development.db`; the `actions.pausedAt` reset and the
`ela.prod` extras are that path's alone.

```js
const appId = pullPath({ flag, log, echo, chalk })
if (appId === false) { $.config.abort = true; return }
if (appId) {
  $.config.viaBasecamp = true
  $.config.appId       = appId
  $.config.dbPath      = $.paths.db
  return
}

const env = $.env

const server     = flag.dev ? env.DEV_SERVER      : env.PROD_SERVER
const serverPath = flag.dev ? env.DEV_SERVER_PATH  : env.PROD_SERVER_PATH

if (!server) {
  // A bare `return` leaves the steps to run with `undefined` interpolated into
  // every ssh/scp/rm they build. `abort` is what refuses the whole command.
  log.error(`${flag.dev ? 'DEV' : 'PROD'}_SERVER not set in .env`)
  $.config.abort = true
  return
}

const date = new Date().toJSON().replace(/:/g, '').split('.')[0]

$.config.server      = server
$.config.serverPath  = serverPath
$.config.dbPath      = $.paths.db
$.config.apiPath     = $.paths.api
$.config.file        = 'production.db'
$.config.backupFile  = `production.db_${date}`
$.config.isElaProd   = server === 'ela.prod'

echo(chalk`  {dim Importing production.db from} ${server}`)
```
