---
title: db:download
description: Download the production sqlite DB from server to db/backups/
alias: db-download
examples:
  - fli db:download
  - fli db:download --dev
  - fli db:download --dry
flags:
  dev:
    type: boolean
    description: Download from dev server instead of production
    defaultValue: false
---

```js
const env    = context.env
const dbPath = context.paths.db
if (!dbPath) { log.error('DB path not configured'); return }

const server     = flag.dev ? env.DEV_SERVER     : env.PROD_SERVER
const serverPath = flag.dev ? env.DEV_SERVER_PATH : env.PROD_SERVER_PATH

if (!server) {
  log.error(`${flag.dev ? 'DEV' : 'PROD'}_SERVER not set in .env`)
  return
}

log.info(`Downloading production.db from ${server}...`)
context.exec({
  command: `scp ${server}:${serverPath}/db/production.db* ${dbPath}/backups/.`,
  dry: flag.dry
})
if (!flag.dry) log.success('Download complete')
```
