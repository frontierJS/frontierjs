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
# Not the directory's index, so it declares its own steps folder rather than
# inheriting `_steps/` — the runtime attaches a bare `_steps/` to index.md only
# (FJS-250). Setting $.config.stepsDir alone is not enough: that redirects
# a steps run, it does not start one.
steps: _steps-rollback
---

Rolls back to the previous release. Defaults to full rollback (web + API).
Use --web or --api to roll back only one part.

```js
const head = await deployTargetFor($, flag, log, { why: 'add one with server, user and path to roll back' })
if (!head) return
const { target, deployConf, resolved, appId } = head

// ─── Resolve scope ────────────────────────────────────────────────────────────
// --web and --api are additive filters. Neither flag = full rollback.
// --web alone = web only. --api alone = API only. Both = full (same as neither).
const both   = !flag.web && !flag.api
const doWeb  = both || flag.web
const doApi  = both || flag.api

const { path, host } = resolved

// Every step below reads an ssh failure as "nothing to roll back", so an
// unreachable box would report a rollback that never happened (FJS-3572).
if (!machineFor($, host, path, deployConf.transport).reach()) {
  log.error(`Cannot reach ${host} — nothing was rolled back`)
  $.config.abort = true
  return
}

const scopeLabel = both ? 'web + API' : doWeb ? 'web only' : 'API only'
log.info(`Rolling back ${appId} on ${target} → ${host} (${scopeLabel})`)

$.config.stepsDir   = '_steps-rollback'
$.config.host       = host
$.config.serverPath = path
$.config.target     = target
$.config.appId      = appId
$.config.deployConf = deployConf
$.config.doWeb      = doWeb
$.config.doApi      = doApi
$.config.startTime  = Date.now()
```
