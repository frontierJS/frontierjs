---
title: deploy:setup
description: Check a server and walk through making it ready for fli deploy
alias: setup-server
examples:
  - fli deploy:setup
  - fli deploy:setup --production
  - fli deploy:setup --auto-install
flags:
  production:
    type: boolean
    description: Set up the production server
    defaultValue: false
  stage:
    type: boolean
    description: Set up the staging server
    defaultValue: false
  auto-install:
    type: boolean
    description: Ask nothing — install every missing dependency and write the Caddy routes
    defaultValue: false
  next-steps:
    type: boolean
    description: End on the checklist of what to do next; a command that does those steps itself runs this with --no-next-steps
    defaultValue: true
# Not the directory's index, so it declares its own steps folder rather than
# inheriting `_steps/` — the runtime attaches a bare `_steps/` to index.md only
# (FJS-250). Setting $.config.stepsDir alone is not enough: that redirects
# a steps run, it does not start one.
steps: _steps-setup
---

Checks the target server for all requirements and walks through
installing what's missing. Writes this app's Caddy routes and creates the
directory structure needed for fli deploy. A box `fli server:create` bought is
then marked as an app's at its cloud, so `fli server` reads it as an app box
and `fli basecamp:create` no longer counts it as one left behind.

```js
const head = await deployTargetFor($, flag, log, { why: 'add one with server, user and path before running setup' })
if (!head) return
const { target, deployConf, resolved, appId } = head

const { server, path } = resolved
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
