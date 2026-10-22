---
title: deploy:all
description: Deploy to server via SSH — auto-detects environment from git branch
alias: deploy
steps: _steps-docker
examples:
  - fli deploy
  - fli deploy --production
  - fli deploy --stage
  - fli deploy --dry
  - fli deploy --resume
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
  resume:
    type: boolean
    description: Continue a deploy a previous run did not finish, taking its lock over
    defaultValue: false
  auto-install:
    type: boolean
    description: If the server needs deploy:setup, install its missing dependencies without asking
    defaultValue: false
  outpost:
    type: boolean
    description: "Enroll the API's box in the app's fleet, where the deploy block says outpost: true"
    defaultValue: true
---

Deploys via SSH. Environment resolved in order:
1. `--production` or `--stage` flag
2. Current git branch (`stage`/`staging` → stage, anything else → dev)
3. Falls back to dev

Needs a `deploy` block in `frontier.config.js` (Docker/SSH/Caddy); without one
it refuses.

```js
const target    = resolveTarget(flag, $.git)
const branch    = $.git.branch()
const branchStr = branch ? ` (branch: ${branch})` : ''

// ─── Detect deploy mode ───────────────────────────────────────────────────────
const deployConf     = await deployConfFor($, flag, log)

// A deploy block with no server is a refusal: the placeholder lands here, and
// so does a block that names only per-target servers.
if (deployConf && !deployConf.server) {
  log.error(`deploy.server is not set. Set it, or pass --server <ssh alias>`)
  $.config.abort = true
  return
}

if (deployConf?.server) {
  // ── Docker/SSH/Caddy deploy (frontier.config.js present) ──────────────────

  // --api and --web are additive filters, matching deploy:rollback, which has
  // had this split since before the deploy side could express it. Neither flag
  // means both halves, which is what an unsplit config wants.
  const bothSides = !flag.api && !flag.web
  const doApi     = bothSides || flag.api
  const doWeb     = (bothSides || flag.web) && deployConf.web !== false

  const api = doApi ? resolveSide(deployConf, target, 'api') : null
  const web = doWeb ? resolveSide(deployConf, target, 'web') : null

  // Where the image is BUILT, which is not necessarily where it runs (2.3f).
  // The same fallback chain every side takes, so declaring nothing resolves to
  // the api target and the pipeline behaves exactly as it did — and declaring
  // `deploy.builder` once builds there and ships the bytes to every target,
  // which is what makes *one artefact, many environments* sayable at all.
  const builder = doApi ? resolveSide(deployConf, target, 'builder') : null

  if ((doApi && !api) || (doWeb && !web)) {
    const missing = doApi && !api ? 'api' : 'web'
    log.error(`Cannot resolve a server and path for the ${missing} side on target: ${target}`)
    log.info(`Set deploy.server + deploy.path, or deploy.${missing}.server + deploy.${missing}.path`)
    $.config.abort = true
    return
  }

  const hosts = distinctHosts([api, web, builder])
  const split = api && web && (api.host !== web.host || api.path !== web.path)

  const scope = bothSides ? 'api + web' : doApi ? 'api only' : 'web only'
  log.info(`Deploying ${scope} to ${target}${branchStr}`)
  for (const h of hosts) log.info(`  ${h.host}:${h.path}`)
  if (builder && api && (builder.host !== api.host || builder.path !== api.path))
    log.info(`  build on ${builder.host}, ship the image to ${api.host}`)
  log.info(`Mode: Docker/SSH/Caddy (frontier.config.js)${split ? ' — split across hosts' : ''}`)

  $.config.stepsDir   = '_steps-docker'
  $.config.api        = api
  $.config.web        = web
  $.config.builder    = builder
  $.config.doApi      = Boolean(api)
  $.config.doWeb      = Boolean(web)
  $.config.hosts      = hosts
  $.config.split      = split
  // The API side is the one that carries the database, the container and the
  // health check, so it is what a step means when it says "the server" without
  // qualifying. A web-only run has no API host at all — steps that need one are
  // skipped by `doApi` rather than reading these.
  $.config.server     = api?.server ?? web?.server
  $.config.user       = api?.user   ?? web?.user
  $.config.serverPath = api?.path   ?? web.path
  $.config.target     = target
  $.config.deployConf = deployConf
  $.config.startTime  = Date.now()

  // ── --plan: print and stop ────────────────────────────────────────────────
  // Phase 1d, and the same document `fli deploy:plan` prints — one helper, two
  // entry points, because a plan is what somebody reads to decide.
  //
  // `stop` rather than a bare return: a bare return runs every step. Stopping
  // leaves 09-cleanup as the only step that executes, and it releases locks
  // this run never took.
  if (flag.plan) {
    const plan = await deployPlan($, flag, { target, deployConf, doApi, doWeb })
    if (plan.error) log.error(plan.error)
    else {
      console.log()
      console.log(plan.text)
      console.log()
    }
    // `stop`, not `abort`: printing the plan is what was asked for, so this
    // exits 0. An abort is a REFUSAL and fails the command (`FJS-589`).
    $.config.stop = true
    return
  }

} else {
  log.error('frontier.config.js has no deploy block')
  log.info('Add one (deploy.server + deploy.path), or run fli make:deploy')
  $.config.abort = true
}
```
