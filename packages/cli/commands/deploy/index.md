---
title: deploy:all
description: Deploy to server via SSH, or release the App through Basecamp when BASECAMP_APP_ID is set — the environment is auto-detected from the git branch
alias: deploy
steps: _steps-docker
examples:
  - fli deploy
  - fli deploy --production
  - fli deploy --stage
  - fli deploy --dry
  - fli deploy --resume
  - fli deploy --production --site
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
  basecamp:
    type: string
    description: The Basecamp an App is released through, by its name in basecamps.json (default the one holding BASECAMP_APP_ID, asked of each entry) — passed to basecamp:deploy
    defaultValue: ''
  site:
    type: boolean
    description: Publish site/ alone, built against the production database (only once its Worker has a deployment)
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
    description: If the server needs deploy:setup, run it with no questions — every missing dependency installed, the Caddy routes written
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
it refuses — unless `BASECAMP_APP_ID` is set (the app's `.env`, the shell, or
`~/.config/fli/.env`), which makes the app one Basecamp runs: the run is then
`fli basecamp:deploy` for that App, preflight and all, and after it for each
static App whose Domain routes back to it — the `app` holding web/, so one
deploy ships web/ and the API as the SSH door does (`FJS-4054`). A failed
release stops the run before the next, and `--dry` is passed through. The target picks the App: `BASECAMP_APP_ID` names any App of the
project, and the one released is the App with the same slug in the project's
environment of the target's tier (`dev` is development, `stage` staging) —
`core/basecamp.js` `resolveBasecampApp`, which refuses by name a tier with no
environment or no such App (`fli basecamp:app --stage` makes it, `FJS-D1965`).
`--api`, `--web`, `--site`, `--plan` and `--resume` are for the ssh deploy and
refused there.

**Both doors release one commit from the same inputs** (`FJS-D1967`), through
`core/release-build.js`: HEAD as committed, an uncommitted edit listed and left
out (`FJS-D1968`); the Dockerfile `chooseDockerfile` picks, with
`deploy/generated/` vendored when it installs from there; and web/ built with
the commit as `VITE_FJS_BUILD` (`FJS-D1969`). The install is what they do not
share: this door keeps the database in `<path>/db` and the env in
`.env.production`, Basecamp keeps them in the App's volume and Variables, and
each mints its own `ENCRYPTION_KEY`. So a box holds one door's install of an
app. The preflight refuses a box where a Basecamp route holds the deploy's
hostname, and Outpost refuses a Basecamp release onto this door's hostname;
both name `fli deploy:move --to=<door>`, which carries the database, the env
and the key across.

A production deploy then publishes `site/`: built here against a copy of the
production database the new API just migrated, and shipped with Sierra's
`deploySite()` signed in as whoever runs this — `CLOUDFLARE_API_TOKEN`, else
`wrangler login` (`FJS-D1687`). Only once the site's Worker has a deployment:
the first one claims `siteUrl`'s domain, and is `fli site:deploy` by hand
(`FJS-D1688`). `--site` runs that step alone.

```js
// ─── An App Basecamp runs ─────────────────────────────────────────────────────
// Ahead of the deploy block, which such an app may still carry as the
// scaffold's placeholder.
if (process.env.BASECAMP_APP_ID) {
  const refused = ['api', 'web', 'site', 'plan', 'resume'].filter(f => flag[f])
  if (refused.length) {
    log.error(`--${refused.join(', --')} ${refused.length === 1 ? 'is' : 'are'} for the ssh deploy — an App Basecamp runs is released whole: run \`fli deploy\``)
    $.config.abort = true
    return
  }
  const released = await releaseThroughBasecamp({ $, flag, log, echo, goal: resolveTarget(flag, $.git) })
  if (released) $.config.stop  = true
  else          $.config.abort = true
  return
}

const target    = resolveTarget(flag, $.git)
const branch    = $.git.branch()
const branchStr = branch ? ` (branch: ${branch})` : ''

// ─── Detect deploy mode ───────────────────────────────────────────────────────
const deployConf     = await deployConfFor($, flag, log)

// A deploy block with no server is a refusal: the placeholder lands here, and
// so does a block that names only per-target servers.
if (deployConf && !deployConf.server) {
  log.error(`deploy.server is not set. Set it, or pass --server <ssh alias>`)
  for (const line of noServerHint(deployConf)) log.info(line)
  $.config.abort = true
  return
}

if (deployConf?.server) {
  // ── Docker/SSH/Caddy deploy (frontier.config.js present) ──────────────────

  // --api and --web are additive filters, matching deploy:rollback, which has
  // had this split since before the deploy side could express it. Neither flag
  // means both halves, which is what an unsplit config wants.
  // --site alone still resolves the API side: its container holds the
  // database the site is built against.
  const siteOnly  = flag.site && !flag.api && !flag.web
  const bothSides = !flag.api && !flag.web && !siteOnly
  const doApi     = bothSides || flag.api
  const doWeb     = (bothSides || flag.web) && deployConf.web !== false

  if (flag.site && target !== 'production') {
    log.error(`--site publishes siteUrl's domain, which only a production deploy does — add --production`)
    $.config.abort = true
    return
  }

  const api = doApi || siteOnly ? resolveSide(deployConf, target, 'api') : null
  const web = doWeb ? resolveSide(deployConf, target, 'web') : null

  // Where the image is BUILT, which is not necessarily where it runs (2.3f).
  // The same fallback chain every side takes, so declaring nothing resolves to
  // the api target and the pipeline behaves exactly as it did — and declaring
  // `deploy.builder` once builds there and ships the bytes to every target,
  // which is what makes *one artefact, many environments* sayable at all.
  const builder = doApi ? resolveSide(deployConf, target, 'builder') : null

  if (((doApi || siteOnly) && !api) || (doWeb && !web)) {
    const missing = !api ? 'api' : 'web'
    log.error(`Cannot resolve a server and path for the ${missing} side on target: ${target}`)
    log.info(`Set deploy.server + deploy.path, or deploy.${missing}.server + deploy.${missing}.path`)
    $.config.abort = true
    return
  }

  const hosts = distinctHosts([api, web, builder])
  const split = api && web && (api.host !== web.host || api.path !== web.path)

  const scope = siteOnly ? 'site only' : doApi && web ? 'api + web' : doApi ? 'api only' : 'web only'
  log.info(`Deploying ${scope} to ${target}${branchStr}`)
  for (const h of hosts) log.info(`  ${h.host}:${h.path}`)
  if (builder && api && (builder.host !== api.host || builder.path !== api.path))
    log.info(`  build on ${builder.host}, ship the image to ${api.host}`)
  log.info(`Mode: Docker/SSH/Caddy (frontier.config.js)${split ? ' — split across hosts' : ''}`)

  $.config.stepsDir   = '_steps-docker'
  $.config.api        = api
  $.config.web        = web
  $.config.builder    = builder
  $.config.doApi      = Boolean(api) && !siteOnly
  $.config.siteOnly   = siteOnly
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

<script>
const { join } = await import('path')
const { spawnSync } = await import('child_process')
const { resolveBasecampApp, basecampAll } = await import(new URL('file://' + global.fliRoot + '/core/basecamp.js'))
const { reachBasecampFor } = await import(new URL('file://' + global.fliRoot + '/core/basecamps.js'))
const { TIERS }           = await import(new URL('file://' + global.fliRoot + '/core/deploy-target.js'))
const { frontingStatics } = await import(new URL('file://' + global.fliRoot + '/core/release-preflight.js'))

/** The target's App, then the static App in front of it: the SSH door's one
 *  deploy ships web/ and the API, and a release of the API alone left the
 *  hostname answering an empty page (FJS-4054). False once one fails. */
async function releaseThroughBasecamp({ $, flag, log, echo, goal }) {
  // BASECAMP_APP_ID names any App of the project; the target's is its
  // same-slug sibling in the target's environment.
  const entry = await reachBasecampFor(flag.basecamp, process.env.BASECAMP_APP_ID, log)
  if (!entry) return false
  let app
  try { app = await resolveBasecampApp(entry.url, entry.key, process.env.BASECAMP_APP_ID, goal, { where: entry.name }) }
  catch (err) { log.error(err.message); return false }

  echo`{dim ${goal} (${TIERS[goal]}) —} releasing App '${app.name}' {dim (${app.id}) through Basecamp}`
  if (!releaseApp($, flag, app.id, entry.name)) return false
  // Read after the release: the first one is what makes the static App.
  for (const web of app.source?.kind === 'inline' ? [] : await staticFronts(entry, app)) {
    echo`{dim web/ —} releasing static App '${web.name}' {dim (${web.id}), in front of '${app.name}'}`
    if (!releaseApp($, flag, web.id, entry.name)) return false
  }
  return true
}

/** `basecamp:deploy` as a child of THIS checkout's fli, never a bare `fli`,
 *  which would be the global install. The entry is named so the child does not
 *  ask every Basecamp again. */
function releaseApp($, flag, id, basecamp) {
  const args = ['basecamp:deploy', '--app', id, '--basecamp', basecamp, ...(flag.dry ? ['--dry'] : [])]
  return spawnSync(process.execPath, [join(global.fliRoot, 'bin/fli.js'), ...args], { cwd: $.paths.root, stdio: 'inherit', env: process.env }).status === 0
}

/** The static Apps in front of `app`, each once. Unread routes count every
 *  static Domain as this App's, so a key without domainRoutes:read still
 *  releases web/. */
async function staticFronts(entry, app) {
  const siblings = await basecampAll(entry.url, entry.key, `/apps?environmentId=${encodeURIComponent(app.environmentId)}`)
  const routes   = await basecampAll(entry.url, entry.key, '/domainRoutes').catch(() => null)
  return [...new Map(frontingStatics({ app, siblings, routes }).map(f => [f.app.id, f.app])).values()]
}
</script>
