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
---

Checks the target server for all requirements and walks through
installing what's missing. Writes nginx config and creates the
directory structure needed for fli deploy.

```js
const target = resolveTarget(flag, context.git)

const frontierConfig = await loadFrontierConfig(context.paths.root)
const deployConf     = frontierConfig?.deploy

if (!deployConf?.server) {
  log.error('No deploy block found in frontier.config.js')
  log.info('Add a deploy block with server, user, and path before running setup')
  context.config.abort = true
  return
}

const resolved = resolveDeployConf(deployConf, target)
if (!resolved) {
  log.error(`deploy.server or deploy.path is not set in frontier.config.js for target: ${target}`)
  context.config.abort = true
  return
}
const { server, user, path } = resolved
const appId      = deployConf.app_id ?? path.split('/').pop()
const domain     = deployConf.web?.domain ?? null
const sslCert    = deployConf.web?.ssl?.cert ?? null
const sslKey     = deployConf.web?.ssl?.key  ?? null
const apiPort    = deployConf.api?.port ?? 3000

const host = `${user}@${server}`

log.info(`Setting up ${host} for ${appId} (${target})`)

context.config.stepsDir   = '_steps-setup'
context.config.host       = host
context.config.server     = server
context.config.serverPath = path
context.config.target     = target
context.config.appId      = appId
context.config.domain     = domain
context.config.sslCert    = sslCert
context.config.sslKey     = sslKey
context.config.apiPort    = apiPort
context.config.deployConf = deployConf
```
