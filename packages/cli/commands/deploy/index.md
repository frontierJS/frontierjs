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
  api:
    type: boolean
    description: Deploy the API only (skip web)
    defaultValue: false
  web:
    type: boolean
    description: Deploy the web only (skip API)
    defaultValue: false
  plan:
    type: boolean
    description: Print the journal rows this deploy would write, and run nothing
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

  // --api and --web are additive filters, matching deploy:rollback, which has
  // had this split since before the deploy side could express it. Neither flag
  // means both halves, which is what an unsplit config wants.
  const bothSides = !flag.api && !flag.web
  const doApi     = bothSides || flag.api
  const doWeb     = (bothSides || flag.web) && deployConf.web !== false

  const api = doApi ? resolveSide(deployConf, target, 'api') : null
  const web = doWeb ? resolveSide(deployConf, target, 'web') : null

  if ((doApi && !api) || (doWeb && !web)) {
    const missing = doApi && !api ? 'api' : 'web'
    log.error(`Cannot resolve a server and path for the ${missing} side on target: ${target}`)
    log.info(`Set deploy.server + deploy.path, or deploy.${missing}.server + deploy.${missing}.path`)
    context.config.abort = true
    return
  }

  const hosts = distinctHosts([api, web])
  const split = api && web && (api.host !== web.host || api.path !== web.path)

  const scope = bothSides ? 'api + web' : doApi ? 'api only' : 'web only'
  log.info(`Deploying ${scope} to ${target}${branchStr}`)
  for (const h of hosts) log.info(`  ${h.host}:${h.path}`)
  log.info(`Mode: Docker/SSH/nginx (frontier.config.js)${split ? ' — split across hosts' : ''}`)

  context.config.stepsDir   = '_steps-docker'
  context.config.api        = api
  context.config.web        = web
  context.config.doApi      = Boolean(api)
  context.config.doWeb      = Boolean(web)
  context.config.hosts      = hosts
  context.config.split      = split
  // The API side is the one that carries the database, the container and the
  // health check, so it is what a step means when it says "the server" without
  // qualifying. A web-only run has no API host at all — steps that need one are
  // skipped by `doApi` rather than reading these.
  context.config.server     = api?.server ?? web.server
  context.config.user       = api?.user   ?? web.user
  context.config.serverPath = api?.path   ?? web.path
  context.config.target     = target
  context.config.deployConf = deployConf
  context.config.startTime  = Date.now()

  // ── --plan: print and stop ────────────────────────────────────────────────
  // Phase 1d, and the same document `fli deploy:plan` prints — one helper, two
  // entry points, because a plan is what somebody reads to decide.
  //
  // `abort` rather than a bare return: the runner discovers steps AFTER the
  // orchestrator runs, and falls back to `_steps/` when no stepsDir is set —
  // which is the legacy CapRover list. Returning early would run it. Aborting
  // leaves 09-cleanup as the only step that executes, and on abort it releases
  // locks this run never took.
  if (flag.plan) {
    const plan = await deployPlan(context, flag, { target, deployConf, doApi, doWeb })
    if (plan.error) log.error(plan.error)
    else {
      console.log()
      console.log(plan.text)
      console.log()
    }
    context.config.abort = true
    return
  }

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
