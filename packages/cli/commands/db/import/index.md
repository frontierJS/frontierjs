---
title: db:import
description: Import the production sqlite DB from server to local dev
alias: db-import
examples:
  - fli db:import
  - fli db:import --dev
  - fli db:import --dry
flags:
  dev:
    type: boolean
    description: Import from dev server instead of production
    defaultValue: false
---

```js
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

log.info(`Importing DB from ${server}`)
```
