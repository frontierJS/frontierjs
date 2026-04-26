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

// Check SSH
try {
  context.exec({ command: `ssh -o ConnectTimeout=5 -o BatchMode=yes ${host} "echo ok" > /dev/null` })
} catch {
  log.error(`Cannot reach ${host}`)
  return
}

// Check container exists
try {
  context.exec({ command: `ssh ${host} "docker inspect ${container} > /dev/null 2>&1"` })
} catch {
  log.error(`Container '${container}' is not running on ${host}`)
  log.info(`Check status with: fli deploy:status${flag.production ? ' --production' : flag.stage ? ' --stage' : ''}`)
  return
}

log.info(`Running in ${container} on ${target} (${host}):`)
log.info(`  ${arg.cmd}`)
echo('')

// docker exec -it requires a tty — use -i only when not interactive (no tty in CI)
// Using -it for local runs so interactive commands (bun repl) work correctly
context.exec({ command: `ssh -t ${host} "docker exec -it ${container} ${arg.cmd}"` })
```
