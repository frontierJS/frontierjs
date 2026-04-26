---
title: deploy:all
description: Deploy to server via SSH — auto-detects environment from git branch
alias: deploy
examples:
  - fli deploy
  - fli deploy --production
  - fli deploy --stage
  - fli deploy --dry
flags:
  production:
    type: boolean
    description: Deploy to production (overrides branch detection)
    defaultValue: false
  stage:
    type: boolean
    description: Deploy to stage (overrides branch detection)
    defaultValue: false
---

Deploys via SSH. Environment resolved in order:
1. `--production` or `--stage` flag
2. Current git branch (`stage`/`staging` → stage, anything else → dev)
3. Falls back to dev

If `frontier.config.js` has a `deploy` block, uses Docker/SSH/nginx deployment.
Otherwise falls back to the legacy CapRover deploy.

```js
const env    = context.env
const target    = resolveTarget(flag, context.git)
const branch    = context.git.branch()
const branchStr = branch ? ` (branch: ${branch})` : ''

// ─── Detect deploy mode ───────────────────────────────────────────────────────
const frontierConfig = await loadFrontierConfig(context.paths.root)
const deployConf     = frontierConfig?.deploy

if (deployConf?.server) {
  // ── Docker/SSH/nginx deploy (frontier.config.js present) ──────────────────
  const resolved = resolveDeployConf(deployConf, target)
  if (!resolved) {
    log.error(`deploy.server or deploy.path is not set in frontier.config.js for target: ${target}`)
    log.info('Add a server address and path to the deploy block and try again')
    context.config.abort = true
    return
  }
  const { server, user, path } = resolved

  log.info(`Deploying to ${target} → ${user}@${server}:${path}${branchStr}`)
  log.info('Mode: Docker/SSH/nginx (frontier.config.js)')

  context.config.stepsDir   = '_steps-docker'
  context.config.server     = server
  context.config.user       = user
  context.config.serverPath = path
  context.config.target     = target
  context.config.deployConf = deployConf
  context.config.startTime  = Date.now()

} else {
  // ── Legacy CapRover deploy (no frontier.config.js deploy block) ────────────
  let server, serverPath

  if (target === 'production') {
    server     = env.PROD_SERVER
    serverPath = env.PROD_SERVER_PATH
  } else if (target === 'stage') {
    server     = env.STAGE_SERVER
    serverPath = env.STAGE_SERVER_PATH
  } else {
    server     = env.DEV_SERVER
    serverPath = env.DEV_SERVER_PATH
  }

  if (!server) {
    const key = target === 'production' ? 'PROD_SERVER' : target === 'stage' ? 'STAGE_SERVER' : 'DEV_SERVER'
    log.error(`${key} is not set in .env`)
    log.info('Add it to your project .env or add a deploy block to frontier.config.js')
    context.config.abort = true
    return
  }

  log.info(`Deploying to ${target} → ${server}${branchStr}`)
  log.info('Mode: legacy CapRover')

  context.config.stepsDir   = '_steps'
  context.config.server     = server
  context.config.serverPath = serverPath
  context.config.target     = target
  context.config.startTime  = Date.now()
}
```
