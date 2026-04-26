---
title: 06-swap
description: Stop old container, start new one — migrations run in entrypoint
---

```js
if (context.config.abort) return

const { host, serverPath, imageTag, appId, apiPort, deployConf } = context.config
const dbPath    = deployConf.db?.path   ?? `${serverPath}/db`
const envFile   = deployConf.api?.env   ?? `${serverPath}/.env.production`
const container = `${appId}-api`
const replaced  = `${container}_replaced`

// ─── Rename existing container to _replaced ───────────────────────────────────
// Gives us a named handle for rollback even after the container is stopped.
const renameCmd = `
  if docker inspect ${container} > /dev/null 2>&1; then
    docker rename ${container} ${replaced}
  fi
`.trim().replace(/\n\s*/g, '; ')

log.info('Renaming current container to _replaced...')
context.exec({ command: `ssh ${host} "${renameCmd}"` })

// ─── Stop _replaced ───────────────────────────────────────────────────────────
// Critical for SQLite: only one writer at a time.
// The new container's entrypoint runs migrations on startup. If _replaced is
// still running when the new container opens the DB, we have two concurrent
// writers — the concurrent WAL scenario that can lose data.
//
// Stopping _replaced here means a brief gap (3-10s) while the new container
// starts and runs migrations. This is the correct tradeoff for SQLite.
//
// Litestream is unaffected — it checkpoints the WAL when _replaced stops,
// ships the checkpoint to the replica, and continues when the new container
// opens the file.
log.info('Stopping _replaced container...')
const stopCmd = `
  if docker inspect ${replaced} > /dev/null 2>&1; then
    docker stop --time 10 ${replaced}
  fi
`.trim().replace(/\n\s*/g, '; ')
context.exec({ command: `ssh ${host} "${stopCmd}"` })

// ─── Start new container ──────────────────────────────────────────────────────
// Entrypoint runs: litestone migrate apply → then bun run src/server.ts
// If migrations fail, the container exits non-zero → health check fails → rollback
log.info(`Starting ${imageTag}...`)
const runCmd = [
  'docker run -d',
  `--name ${container}`,
  '--restart unless-stopped',
  `-p 127.0.0.1:${apiPort}:3000`,
  `--volume ${dbPath}:/db`,
  `--env-file ${envFile}`,
  `--env NODE_ENV=production`,
  imageTag,
].join(' ')

context.exec({ command: `ssh ${host} "${runCmd}"` })

context.config.container = container
context.config.replaced  = replaced
log.success(`Container started → ${container}`)
log.info('  Running migrations in entrypoint...')
```
