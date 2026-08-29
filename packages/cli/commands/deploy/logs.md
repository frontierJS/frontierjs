---
title: deploy:logs
description: Stream or show logs from the running API container on the server
alias: dlogs
examples:
  - fli deploy:logs
  - fli deploy:logs --production
  - fli deploy:logs --follow
  - fli deploy:logs --tail 100
  - fli deploy:logs --stage --follow
flags:
  production:
    type: boolean
    description: Target production server
    defaultValue: false
  stage:
    type: boolean
    description: Target staging server
    defaultValue: false
  follow:
    char: f
    type: boolean
    description: Stream logs (follow mode — Ctrl+C to stop)
    defaultValue: false
  tail:
    char: n
    type: string
    description: Number of lines to show from the end
    defaultValue: '50'
---

```js
const target = resolveTarget(flag, context.git)

const frontierConfig = await loadFrontierConfig(context.paths.root)
const deployConf     = frontierConfig?.deploy

if (!deployConf?.server) {
  log.error('No deploy block found in frontier.config.js')
  context.config.abort = true
  return
}

const resolved = resolveDeployConf(deployConf, target)
if (!resolved) {
  log.error(`deploy.server or deploy.path is not set for target: ${target}`)
  context.config.abort = true
  return
}

const { server, user, path } = resolved
const appId     = deployConf.app_id ?? path.split('/').pop()
const container = `${appId}-api`
const host      = `${user}@${server}`

// Check the machine, then the container
const machine = machineFor(context, host, path, deployConf.transport)

if (!machine.reach()) {
  log.error(`Cannot reach ${host}`)
  return
}

try {
  machine.run(`docker inspect ${container} > /dev/null 2>&1`)
} catch {
  log.error(`Container '${container}' is not running on ${host}`)
  log.info(`Check status with: fli deploy:status${flag.production ? ' --production' : flag.stage ? ' --stage' : ''}`)
  return
}

const followFlag = flag.follow ? ' --follow' : ''
const tailFlag   = ` --tail ${flag.tail}`

log.info(`${container} on ${target} (${machine.describe()})${flag.follow ? ' — streaming, Ctrl+C to stop' : ''}`)
echo('')

// `tty`, not `run`: --follow streams until Ctrl+C, so stdin has to stay the
// terminal rather than carry a script.
machine.tty(`docker logs${followFlag}${tailFlag} ${container}`)
```
