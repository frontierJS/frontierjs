---
title: deploy:pause
description: Take the app down on purpose — the edge refuses, the app keeps running, and the journal records who and when
alias: pause
examples:
  - fli deploy:pause
  - fli deploy:pause --production
flags:
  production:
    type: boolean
    description: Pause production (overrides branch detection)
    defaultValue: false
  stage:
    type: boolean
    description: Pause staging
    defaultValue: false
steps: _steps-pause
---

```js
const target         = resolveTarget(flag, context.git)
const frontierConfig = await loadFrontierConfig(context.paths.root)
const deployConf     = frontierConfig?.deploy

if (!deployConf?.server) {
  log.error('No deploy block in frontier.config.js — there is no journal to record a pause in')
  context.config.abort = true
  return
}

const api = resolveSide(deployConf, target, 'api')
if (!api) {
  log.error(`Cannot resolve a server and path for the api side on target: ${target}`)
  context.config.abort = true
  return
}

context.config.stepsDir   = '_steps-pause'
context.config.pauseKind  = 'pause'
context.config.target     = target
context.config.deployConf = deployConf
context.config.api        = api
context.config.hosts      = distinctHosts([api])
context.config.host       = api.host
context.config.serverPath = api.path
context.config.appId      = deployConf.app_id ?? deployConf.path.split('/').pop()
context.config.apiPort    = deployConf.api?.port ?? 3000
context.config.healthPath = deployConf.api?.health ?? '/health'
// The name the vhost is written for, which is what `03-verify` has to ask
// through — a machine serving several apps answers the wrong one otherwise.
context.config.edgeHost   = deployConf.web?.domain ?? null
context.config.startTime  = Date.now()

log.info(`Pausing ${context.config.appId} on ${target}`)
```

## What a pause is

The app keeps running. `fli deploy:pause` writes one file and nginx refuses every
request for this vhost from the next one, with a 503 and a `Retry-After` — the
status that keeps a paused app in a search index rather than out of it.

It is a transition, not a flag. The journal records which Release was serving,
who paused it and when, which is what separates *down on purpose* from *down*.
Stopping the container is the thing this replaces: it looks identical to a crash
from every reader, and it cannot deploy, because the migrations run in the
container's own entrypoint.

## The queues

**The edge stops callers; the queues are the other half.** Jobs, crons and the
transactional outbox run inside the container, which stays up, so once the edge
is refusing the pause drains every Caravan queue in the running app — the case a
pause is most reached for is a migration nothing may write through, and a job is
a writer. Work already running finishes; a job dispatched while paused is queued
and runs on unpause.

It is done by running Caravan's own `caravan queue drain` inside the serving
container (`FJS-D262`), so the database it pauses is the one the app has open
and nothing here knows where that is. The pause is held by the deploy, and
`fli deploy:unpause` lifts that one and no other: a queue an operator paused
before you is still paused after.

An app with no Caravan, or no container running, is said so and is not a
failure. A bin that REFUSES — two jobs databases open in one container — fails
the transition with the edge still paused, and running the pause again is how
it finishes.

## Deploying while paused

Supported, and it is what the pause is for. `fli deploy` swaps the container and
moves the web symlink; neither touches the guard file, so the app stays paused
across a deploy and the health check still passes — it polls the API port
directly and never goes through nginx.

`fli deploy:unpause` lifts it. `fli deploy:status` prints what the journal says
and what the edge is actually doing, which is the pair worth reading: they can
disagree, and neither is repaired behind your back.
