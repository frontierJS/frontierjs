---
title: deploy:unpause
description: Serve again — remove the guard, record that the app is back, and check the edge agrees
alias: unpause
examples:
  - fli deploy:unpause
  - fli deploy:unpause --production
flags:
  production:
    type: boolean
    description: Unpause production (overrides branch detection)
    defaultValue: false
  stage:
    type: boolean
    description: Unpause staging
    defaultValue: false
steps: _steps-pause
---

```js
const target         = resolveTarget(flag, context.git)
const frontierConfig = await loadFrontierConfig(context.paths.root)
const deployConf     = frontierConfig?.deploy

if (!deployConf?.server) {
  log.error('No deploy block in frontier.config.js — there is no journal to record an unpause in')
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
context.config.pauseKind  = 'unpause'
context.config.target     = target
context.config.deployConf = deployConf
context.config.api        = api
context.config.hosts      = distinctHosts([api])
context.config.host       = api.host
context.config.serverPath = api.path
context.config.appId      = deployConf.app_id ?? deployConf.path.split('/').pop()
context.config.apiPort    = deployConf.api?.port ?? 3000
context.config.healthPath = deployConf.api?.health ?? '/health'
context.config.edgeHost   = deployConf.web?.domain ?? null
context.config.startTime  = Date.now()

log.info(`Unpausing ${context.config.appId} on ${target}`)
```

## The queues come back first

The reverse of the pause: every queue a deploy paused is resumed, and only then
is the guard file removed. A queue pause somebody made by hand — `caravan queue
pause` from a console — is left in force and printed, because this command owns
the pause a deploy made and not theirs. If the resume is refused, the edge is
left paused rather than serving an app whose jobs are held.

## Why it is not called `deploy:resume`

`fli deploy --resume` already means *continue an interrupted transition*. Two
different operations one keystroke apart, in the command somebody types during an
incident, is worth an uglier word for.

## It runs against a target nobody paused through fli

Deliberately. An unpause removes the guard file whether or not a journal row put
it there, and records that the app is serving — which is how *paused by hand*,
the state `fli deploy:status` reports when the edge is refusing and nothing says
why, stops being the answer.

It still needs a journal, because that is where the record goes. A target that
has never deployed through one has nothing to write to, and the refusal says so;
the file is an ordinary file and `rm` is the answer there.
