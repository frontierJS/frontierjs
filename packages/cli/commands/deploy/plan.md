---
title: deploy:plan
description: Print the journal rows this deploy would write — executes nothing
examples:
  - fli deploy:plan
  - fli deploy:plan --production
  - fli deploy:plan --api
  - fli deploy:plan --json
flags:
  production:
    type: boolean
    description: Plan for production (overrides branch detection)
    defaultValue: false
  stage:
    type: boolean
    description: Plan for stage
    defaultValue: false
  api:
    type: boolean
    description: Plan the API side only
    defaultValue: false
  web:
    type: boolean
    description: Plan the web side only
    defaultValue: false
  digest:
    char: d
    type: string
    description: The image digest, where one has been built
    defaultValue: ''
  json:
    char: j
    type: boolean
    description: Emit the rows as JSON, exactly as they would be inserted
    defaultValue: false
---

```js
const target         = resolveTarget(flag, $.git)
const deployConf     = await deployConfFor($, flag, log)

if (!deployConf?.server) {
  log.error('No deploy block in frontier.config.js — there is nothing to plan against')
  log.info('Run `fli make:deploy --server <host>` to write one')
  $.config.abort = true
  return
}

// The same additive filters `fli deploy` applies, so a plan describes the run
// the identical flags would produce and not a different one.
const bothSides = !flag.api && !flag.web
const doApi     = bothSides || flag.api
const doWeb     = (bothSides || flag.web) && deployConf.web !== false
const doWidgets = (bothSides || flag.web) && widgetsOn(deployConf)

const plan = await deployPlan($, flag, { target, deployConf, doApi, doWeb, doWidgets })

if (plan.error) {
  log.error(plan.error)
  $.config.abort = true
  return
}

if (flag.json) {
  console.log(JSON.stringify(
    { release: plan.release, transition: plan.transition, steps: plan.steps }, null, 2))
  return
}

console.log()
console.log(plan.text)
console.log()
```

## What this is

The rows `db/deploy.lite` would receive — one `Transition` and one
`TransitionStep` per step — printed instead of inserted. It is the same object
either way: the model carries the plan on the transition itself, so the plan a
person read and the record a deploy wrote cannot be two documents that disagree.

`fli deploy --plan` prints exactly this and then stops. Two entry points, one
implementation, because a plan is what somebody reads to decide.

## The steps are read, not listed

They come from `_steps-docker/`, with the runner's own filter and sort, and each
`skip:` predicate is evaluated the way the runner evaluates it. A step this
prints as *skipped* is a step that will be skipped; a step added to the pipeline
appears here without anyone editing this command.

A skipped step is shown rather than dropped. An operator needs *the backup did
not run* to be visible, and the ordinals have to stay stable so a resumed
transition can find where it stopped even after a `skip:` has changed its answer.

## The pivot is decided on the target

```
Pivot         decided on the target at deploy time, against the schema the live release runs
```

Whether Release N-1 can still serve is relative to the schema the live container
migrated to, and a plan reaches no server, so it does not guess. `fli deploy`
asks Outpost's classifier on the target once the image is built (`04c-journal`)
and records the verdict on the transition (`FJS-4004`): a contract, an unknown
or a classifier that could not run is the pivot, after which only forward.
`fli release:check` previews the change against your committed baseline.

## The transition id, and the one term a plan cannot answer

```
deploy:shop:production:none:a1b2c3d4e5f6:1:1
 kind  app  environment  from  to  generation  attempt
```

Every term is there for a collision it prevents. `from → to` is what lets a
crashed deploy be resumed — rerunning computes the same id and finds the same
row — while keeping R1→R2 and R2→R1 apart. `generation` is there because a
rotated secret is a new intent rather than a replay of the old one.

**`attempt` is the journal's count of prior transitions for that pair, and a
plan has no journal to count.** So it says `1` and labels the id provisional.
The case it exists for: deploy R2, revert to R1, deploy R2 again — every other
term is identical to the first attempt, so without a counter the third operation
would resume a transition already marked `succeeded` and leave R1 serving.

## What it deliberately does not do

It writes nothing, reaches no server, and exits 0. There
is nothing to refuse: a plan is a document. `fli release:check --strict` is the
gate, and it belongs on the branch that deploys.
