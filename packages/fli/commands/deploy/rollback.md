---
title: deploy:rollback
description: Roll back web and API to the previous release
alias: rollback
examples:
  - fli deploy:rollback
  - fli deploy:rollback --production
  - fli deploy:rollback --web
  - fli deploy:rollback --api
  - fli deploy:rollback --web --production
  - fli deploy:rollback --dry
flags:
  production:
    type: boolean
    description: Roll back production (overrides branch detection)
    defaultValue: false
  stage:
    type: boolean
    description: Roll back staging
    defaultValue: false
  web:
    type: boolean
    description: Roll back web only (skip API)
    defaultValue: false
  api:
    type: boolean
    description: Roll back API only (skip web)
    defaultValue: false
---

Rolls back to the previous release. Defaults to full rollback (web + API).
Use --web or --api to roll back only one part.

```js
const target = resolveTarget(flag, context.git)

// ─── Resolve scope ────────────────────────────────────────────────────────────
// --web and --api are additive filters. Neither flag = full rollback.
// --web alone = web only. --api alone = API only. Both = full (same as neither).
const both   = !flag.web && !flag.api
const doWeb  = both || flag.web
const doApi  = both || flag.api

// ─── Load config ──────────────────────────────────────────────────────────────
const frontierConfig = await loadFrontierConfig(context.paths.root)
const deployConf     = frontierConfig?.deploy

if (!deployConf?.server) {
  log.error('No deploy block found in frontier.config.js')
  log.info('Add a deploy block with server, user, and path to enable rollback')
  context.config.abort = true
  return
}

const targetConf = deployConf[target] ?? {}
const server     = targetConf.server ?? deployConf.server
const user       = targetConf.user   ?? deployConf.user ?? 'deploy'
const path       = targetConf.path   ?? deployConf.path
const appId      = deployConf.app_id ?? path.split('/').pop()
const host       = `${user}@${server}`

const scopeLabel = both ? 'web + API' : doWeb ? 'web only' : 'API only'
log.info(`Rolling back ${appId} on ${target} → ${host} (${scopeLabel})`)

context.config.stepsDir   = '_steps-rollback'
context.config.host       = host
context.config.serverPath = path
context.config.target     = target
context.config.appId      = appId
context.config.deployConf = deployConf
context.config.doWeb      = doWeb
context.config.doApi      = doApi
context.config.startTime  = Date.now()
```
