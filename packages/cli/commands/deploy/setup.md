---
title: deploy:setup
description: Check a server and walk through making it ready for fli deploy
alias: setup-server
examples:
  - fli deploy:setup
  - fli deploy:setup --production
flags:
  production:
    type: boolean
    description: Set up the production server
    defaultValue: false
  stage:
    type: boolean
    description: Set up the staging server
    defaultValue: false
# Not the directory's index, so it declares its own steps folder rather than
# inheriting `_steps/` — the runtime attaches a bare `_steps/` to index.md only
# (FJS-250). Setting $.config.stepsDir alone is not enough: that redirects
# a steps run, it does not start one.
steps: _steps-setup
---

Checks the target server for all requirements and walks through
installing what's missing. Writes this app's Caddy routes and creates the
directory structure needed for fli deploy.

```js
const target = resolveTarget(flag, $.git)

const deployConf     = await deployConfFor($, flag, log)

if (!deployConf?.server) {
  log.error('No deploy block found in frontier.config.js')
  log.info('Add a deploy block with server, user, and path before running setup')
  $.config.abort = true
  return
}

const resolved = resolveDeployConf(deployConf, target)
if (!resolved) {
  log.error(`deploy.server or deploy.path is not set in frontier.config.js for target: ${target}`)
  $.config.abort = true
  return
}
const { server, user, path } = resolved
const appId      = deployConf.app_id ?? path.split('/').pop()
const apiPort    = deployConf.api?.port ?? 3000

const { edgeNames, EdgeError } = await import(new URL('file://' + global.fliRoot + '/core/edge.js'))
let edge
try { edge = edgeNames(deployConf) }
catch (e) {
  if (!(e instanceof EdgeError)) throw e
  log.error(e.message)
  $.config.abort = true
  return
}

const host = resolved.host

log.info(`Setting up ${host} for ${appId} (${target})`)

$.config.stepsDir   = '_steps-setup'
$.config.host       = host
$.config.server     = server
$.config.serverPath = path
$.config.target     = target
$.config.appId      = appId
$.config.edge       = edge
$.config.domain     = edge.web.domain
$.config.apiPort    = apiPort
$.config.deployConf = deployConf
```
