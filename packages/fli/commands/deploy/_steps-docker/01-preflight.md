---
title: 01-preflight
description: Validate config, check SSH, acquire deploy lock
---

```js
if (context.config.abort) return

const { server, user, serverPath, target } = context.config
const host = `${user}@${server}`

// ─── Validate required config ─────────────────────────────────────────────────
const deployConf = context.config.deployConf
const appId      = deployConf.app_id ?? deployConf.path.split('/').pop()
const apiPort    = deployConf.api?.port ?? 3000
const healthPath = deployConf.api?.health ?? '/health'

context.config.host       = host
context.config.appId      = appId
context.config.apiPort    = apiPort
context.config.healthPath = healthPath
context.config.commit     = context.git.branch() || 'unknown'

// ─── Check SSH connectivity ───────────────────────────────────────────────────
log.info(`Checking SSH → ${host}`)
try {
  context.exec({ command: `ssh -o ConnectTimeout=5 -o BatchMode=yes ${host} "echo ok" > /dev/null` })
} catch {
  log.error(`Cannot reach ${host} — check your SSH key and server address`)
  context.config.abort = true
  return
}

// ─── Acquire deploy lock ──────────────────────────────────────────────────────
// Prevents two deploys running simultaneously against the same server.
// Lock file: {serverPath}/.deploy.lock
const lockFile = `${serverPath}/.deploy.lock`
const lockCmd  = `
  if [ -f ${lockFile} ]; then
    echo "LOCKED: $(cat ${lockFile})"
    exit 1
  fi
  echo "$$:$(date -u +%Y-%m-%dT%H:%M:%SZ):${target}" > ${lockFile}
  echo "ok"
`.trim().replace(/\n\s*/g, '; ')

log.info('Acquiring deploy lock...')
try {
  context.exec({ command: `ssh ${host} "${lockCmd}"` })
} catch {
  log.error(`Deploy already in progress on ${server} — if this is stale, remove ${lockFile}`)
  context.config.abort = true
  return
}

context.config.lockAcquired = true

// ─── Litestream detection ─────────────────────────────────────────────────────
// Litestream runs as a separate process outside Docker — do not stop it.
// We just need to know it's there so we can log it and remind the operator
// that continuous replication is active throughout the deploy.
let litestreamRunning = false
try {
  context.exec({ command: `ssh ${host} "pgrep -x litestream > /dev/null 2>&1"` })
  litestreamRunning = true
  log.info('Litestream: running — continuous WAL replication active')
  log.info('  DB will be replicated throughout the deploy. Do not stop Litestream.')
} catch {
  log.info('Litestream: not running')
}
context.config.litestreamRunning = litestreamRunning

log.success(`Preflight passed → ${appId} (${target})`)
```
