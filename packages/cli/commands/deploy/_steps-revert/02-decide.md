---
title: 02-decide
description: Read the journal, choose the release to restore, and refuse by name
---

```js
if (context.config.abort) return

const { host, serverPath, deployConf, target, appId } = context.config

const core = (name) => import(new URL('file://' + global.fliRoot + '/core/' + name))
const { chooseTarget, transitionsSince, imageFromSteps, revertRefusals, blocking, formatRevertPlan, REFUSALS } =
  await core('revert.js')

const j = await connectJournal(context, { host, serverPath, deployConf })

const history = await j.history({ app: appId, environment: target, limit: 50 })
const chosen  = chooseTarget(history, { to: flag.to || null })

// `no-journal` is its own answer and not a refusal to override: there is nothing
// recorded, so there is nothing this command can restore. It names the command
// that works without one rather than leaving the operator stuck.
if (chosen.reason === 'no-journal') {
  log.error(`Nothing recorded for ${appId} · ${target} — ${REFUSALS['no-journal']}`)
  log.info('')
  log.info('  `fli deploy:rollback` puts the previous image back with no journal.')
  log.info('  It restores the code and cannot tell you what else moved.')
  context.config.abort = true
  return
}

const targetRelease = chosen.targetId ? await j.release(chosen.targetId) : null
const since         = chosen.targetId ? transitionsSince(history, chosen.targetId) : []
const state         = await j.state({ app: appId, environment: target })

// The bytes, read back off the step that built them — under build-on-target the
// digest is not a term of the Release, so the way to an image is the transition
// that put it into service (`04c-journal`).
//
// Read off `chosen.previous`, the TRANSITION, rather than looked up by release
// id: two deploys of different source mint the same id, so a lookup answers the
// newest — which is the one serving — and the revert restores what it was
// reverting from. `servingTransition` is the fallback for a `--to` naming a
// release with no transition in the window.
const imageOf = async (t) => (t ? imageFromSteps(await j.stepsOf(t.id)) : null)

let image = { image: null, raw: null, parsed: false }
if (targetRelease) {
  const built = chosen.previous
    ?? await j.servingTransition({ app: appId, environment: target, releaseId: targetRelease.id })
  if (built) image = await imageOf(built)
}

// What is running now — asked of the MACHINE, not of the journal.
//
// The journal records what each transition intended, and a revert transition
// has no build step to intend an image with, so after one revert the journal
// cannot say what is running. Docker can, and that is the fact the `same-bytes`
// refusal is about: not what was meant, what is up. An unreadable answer decides
// nothing rather than deciding *the same*.
const running = machineFor(context, host, serverPath)
  .capture(`docker inspect ${appId}-api --format '{{.Image}}' 2>/dev/null || echo ''`)
const servingImage = running ? { image: running } : null

const refusals = revertRefusals({
  serving:    chosen.serving,
  target:     targetRelease,
  since,
  generation: state.generation,
  image,
  servingImage,
  inFlight:   chosen.inFlight,
  force:      context.config.force,
})

console.log()
console.log(formatRevertPlan({
  app: appId, environment: target,
  serving: chosen.serving, target: targetRelease, since, image, servingImage, refusals,
}))
console.log()

const stopping = blocking(refusals)
if (stopping.length) {
  log.error(`Refusing: ${stopping.map(r => r.kind).join(', ')}`)
  context.config.abort = true
  return
}

if (flag.plan) {
  log.info('--plan: nothing was written or run.')
  // `stop`, not `abort`: the six refusals above this line fail the command,
  // and asking for a plan is not one of them (`FJS-589`).
  context.config.stop = true
  return
}

if (refusals.length) log.warn(`Proceeding with ${refusals.length} refusal(s) overridden.`)

// ─── Record the revert as a transition of its own ────────────────────────────
// A revert is a move of serving state, so it is a row like any other — `kind:
// 'revert'`. Without it the next revert would read the deploy that preceded this
// one as still serving, and offer to go back to a release this command just left.
const { readdirSync, readFileSync } = await import('fs')
const { stepFilesIn, stepNameOf, planSteps, planTransition } = await core('plan.js')
const { extractFrontmatter } = await core('compiler.js')

const dir   = new URL('file://' + global.fliRoot + '/commands/deploy/_steps-revert').pathname
const metas = stepFilesIn(readdirSync(dir)).map(f => {
  const fm = extractFrontmatter(readFileSync(`${dir}/${f}`, 'utf8')) ?? {}
  return { name: stepNameOf(f), title: fm.title, skip: fm.skip }
})

const intent = {
  kind: 'revert', app: appId, environment: target,
  fromReleaseId: chosen.serving?.releaseId ?? null,
  releaseId: targetRelease.id, generation: state.generation ?? targetRelease.generation,
}
const { attempt } = await j.attempt(intent)

const planned = planTransition({
  kind: 'revert',
  release: { ...targetRelease, app: appId, environment: target },
  steps: planSteps(metas, { flag, context: { config: context.config } }),
  fromReleaseId: intent.fromReleaseId,
  generation:    intent.generation,
  attempt,
  actor: context.git.user?.() ?? null,
})

// `crossesPivot` on a REVERT means the operator forced their way past one — the
// classifier's answer is about a deploy, and what matters afterwards is what was
// agreed to here.
planned.transition.crossesPivot = refusals.some(r => r.kind === 'pivot')

await j.begin({ release: { ...targetRelease, app: appId, environment: target }, transition: planned.transition, steps: planned.steps })

// 01 and 02 have already run — they are what decided this is allowed — so they
// are recorded as done rather than left pending forever.
const { occurrenceKey } = await import('@frontierjs/toolbelt/history')
for (const name of ['01-preflight', '02-decide'])
  await j.finish({ id: occurrenceKey('revert', planned.transition.id, name), status: 'succeeded' })

context.config.journal = {
  async beforeStep(name) {
    await j.claim({ id: occurrenceKey('revert', planned.transition.id, name) })
    return { run: true }
  },
  async afterStep(name, _o, { status, durationMs, output } = {}) {
    // A step may leave one line for the journal — `03-swap` leaves the image it
    // restored, which is what makes this revert itself a revert target. Same
    // keyed bag the deploy side drains.
    await j.finish({
      id: occurrenceKey('revert', planned.transition.id, name),
      status, durationMs, output: output ?? takeNote(context, name),
    })
  },
  async settle(status) { await j.settle({ id: planned.transition.id, status }) },
}

context.config.transitionId  = planned.transition.id
context.config.journalClient = j
context.config.revertTo      = targetRelease
context.config.revertImage   = image.image
context.config.revertFrom    = chosen.serving

log.success(`Revert transition opened → ${planned.transition.id}`)
```
