---
title: 03-directories
description: Create the app directory structure on the server
---

```js
if (context.config.abort) return

const { host, serverPath } = context.config

log.info(`Creating directory structure at ${serverPath}...`)

const dirs = [
  serverPath,
  `${serverPath}/db`,
  `${serverPath}/releases`,
  `${serverPath}/web`,
].join(' ')

context.exec({ command: `ssh ${host} "mkdir -p ${dirs}"` })

// Create a placeholder .env.production if it doesn't exist yet
const envFile = `${serverPath}/.env.production`
const envCheck = `[ -f ${envFile} ] || echo "# Add your production env vars here" > ${envFile}`
context.exec({ command: `ssh ${host} "${envCheck}"` })

log.success('Directories ready')
log.info(`  ${serverPath}/db          ← SQLite database`)
log.info(`  ${serverPath}/releases/   ← web release history`)
log.info(`  ${serverPath}/web/        ← web source (for server-side builds)`)
log.info(`  ${serverPath}/.env.production  ← populate before first deploy`)
```
