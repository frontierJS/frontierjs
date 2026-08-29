---
title: deploy:run
description: Run a one-off command inside the running API container on the server
alias: drun
examples:
  - fli deploy:run "bun run db:seed"
  - fli deploy:run --production "bun run scripts/backfill.ts"
  - fli deploy:run --stage "bun run src/scripts/fix-statuses.ts"
  - fli deploy:run "bun repl"
args:
  -
    name: cmd
    description: Command to run inside the container
    required: true
flags:
  production:
    type: boolean
    description: Target production server
    defaultValue: false
  stage:
    type: boolean
    description: Target staging server
    defaultValue: false
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

log.info(`Running in ${container} on ${target} (${machine.describe()}):`)
log.info(`  ${arg.cmd}`)
echo('')

// -it so an interactive command (bun repl) works. The operator's command is
// passed through verbatim: `machine.tty` single-quotes it, so a `$` they typed
// reaches the container rather than being expanded here.
machine.tty(`docker exec -it ${container} ${arg.cmd}`)
```
