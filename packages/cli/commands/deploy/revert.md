---
title: deploy:revert
description: Restore the pair (Release, Generation) from the journal — and refuse by name when it cannot
alias: revert
examples:
  - fli deploy:revert --plan
  - fli deploy:revert
  - fli deploy:revert --production --to a1b2c3d4e5f6
  - fli deploy:revert --onto-current-bindings
flags:
  production:
    type: boolean
    description: Revert production (overrides branch detection)
    defaultValue: false
  stage:
    type: boolean
    description: Revert staging
    defaultValue: false
  to:
    char: t
    type: string
    description: Revert to a specific Release id rather than the one before
    defaultValue: ''
  plan:
    type: boolean
    description: Print what would happen and run nothing
    defaultValue: false
  past-pivot:
    type: boolean
    description: Revert past a deploy that crossed the pivot — the schema will not go back
    defaultValue: false
  past-retention:
    type: boolean
    description: Revert to a release whose retention has expired
    defaultValue: false
  onto-current-bindings:
    type: boolean
    description: Restore the code onto today's configuration rather than the pair
    defaultValue: false
steps: _steps-revert
---

```js
const target         = resolveTarget(flag, context.git)
const frontierConfig = await loadFrontierConfig(context.paths.root)
const deployConf     = frontierConfig?.deploy

if (!deployConf?.server) {
  log.error('No deploy block in frontier.config.js — there is no journal to revert from')
  context.config.abort = true
  return
}

const api = resolveSide(deployConf, target, 'api')
if (!api) {
  log.error(`Cannot resolve a server and path for the api side on target: ${target}`)
  context.config.abort = true
  return
}

context.config.stepsDir   = '_steps-revert'
context.config.target     = target
context.config.deployConf = deployConf
context.config.api        = api
context.config.hosts      = distinctHosts([api])
context.config.host       = api.host
context.config.serverPath = api.path
context.config.appId      = deployConf.app_id ?? deployConf.path.split('/').pop()
context.config.apiPort    = deployConf.api?.port ?? 3000
context.config.healthPath = deployConf.api?.health ?? '/health'
context.config.doApi      = true
context.config.doWeb      = false
context.config.startTime  = Date.now()
context.config.force      = {
  pivot:     flag['past-pivot'],
  retention: flag['past-retention'],
  bindings:  flag['onto-current-bindings'],
}

log.info(`Reverting ${context.config.appId} on ${target}`)
log.info(`  ${api.host}:${api.path}`)
```

## revert is not rollback, and both are kept

| | |
| --- | --- |
| `fli deploy:rollback` | put the previous **image** back. No journal, no history, no questions — it works on a target that has never deployed through a journal at all |
| `fli deploy:revert` | restore the **pair** (Release, Generation), and refuse by name when it cannot |

The second never silently becomes the first. A refusal names the flag that would
override it, and the flags are separate so overriding one does not quietly
override the rest.

## The refusals are the feature

A rollback that puts the previous image back and says nothing is what every other
tool ships, and it is wrong in exactly the situations somebody reaches for it.

```
2 refusal(s):
  ✗ pivot
    1 deploy(s) since a1b2c3d4e5f6 crossed the pivot — release a1b2c3d4e5f6
    cannot serve this database. Recovery past a pivot is forward, not back
    override with --past-pivot
  ✗ bindings
    release a1b2c3d4e5f6 was bound at generation 2 and generation 3 is in force —
    reverting restores the code and NOT the configuration it ran with
    override with --onto-current-bindings
```

**All of them are printed, never just the first.** An operator deciding whether
to force needs the whole picture; a checker that stops at the first refusal makes
them discover the rest one flag at a time, mid-incident.

Two carry **no override at all**, because neither is a judgement call: a
transition still open (a deploy is running, or one died without settling), and a
release whose bytes nothing recorded — there is no image to start.

## Why bindings are refused rather than fixed

Serving state is the pair. `fli` writes no `.env` on a target — the operator owns
that file — so once the binding generation has moved, a revert genuinely cannot
restore the pair. It can only put old code onto today's configuration, which is
the documented Fly failure this separation exists to refuse.

`--onto-current-bindings` is the operator saying they have read which keys moved
and want it anyway. It is a different sentence from *restore the pair*, and the
journal records which one happened.

## `--plan` first

`fli deploy:revert --plan` prints the target, the bytes, the generation and every
refusal, and touches nothing. It is the same escape hatch `fli deploy --plan` is,
arriving at the command where an operator is most likely to be in a hurry.
