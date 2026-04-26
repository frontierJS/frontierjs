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
const env = context.env

const server     = flag.dev ? env.DEV_SERVER      : env.PROD_SERVER
const serverPath = flag.dev ? env.DEV_SERVER_PATH  : env.PROD_SERVER_PATH

if (!server) {
  log.error(`${flag.dev ? 'DEV' : 'PROD'}_SERVER not set in .env`)
  return
}

const date = new Date().toJSON().replace(/:/g, '').split('.')[0]

context.config.server      = server
context.config.serverPath  = serverPath
context.config.dbPath      = context.paths.db
context.config.apiPath     = context.paths.api
context.config.file        = 'production.db'
context.config.backupFile  = `production.db_${date}`
context.config.isElaProd   = server === 'ela.prod'

log.info(`Importing DB from ${server}`)
```
