---
title: 04c-journal
description: Open the deploy journal on the target and record this transition
skip: "context.flag.dry || context.config.deployConf.journal === false"
---

```js
if (context.config.abort) return

const { host, path: serverPath } = context.config.api ?? context.config.web

// ─── Why here, and it moved ──────────────────────────────────────────────────
// After the lock, so two deploys cannot open the same transition — and after the
// BUILD, which is the ordering the whole of `2.3f` turns on: a Release is
// content-addressed on the bytes it names, so it cannot be minted before the
// bytes exist. Opening the transition first left `digest` null in every Release
// this pipeline has ever recorded, which made two deploys of different source
// mint the same id (measured: `fli deploy:revert` restored the bytes it was
// reverting from and reported success).
//
// What it costs is that a build failure now records nothing, and that is the
// correct answer rather than the price: no artefact, no Release, nothing
// transitioned. The old ordering wrote a `failed` transition naming a Release
// that had never been built.
//
// The journal is on the TARGET because it records what happened on that host —
// two operators deploying from two laptops must not hold two answers to what is
// serving.
const opened = await openDeployJournal(context, context.flag, {
  target:     context.config.target,
  deployConf: context.config.deployConf,
  doApi:      context.config.doApi,
  doWeb:      context.config.doWeb,
  // The bytes step 04 produced. Under build-on-target this is an image ID, true
  // on this host and nowhere else — `core/image.js` keeps the two apart and
  // `describeIdentity` says which one it has.
  digest:     context.config.imageIdentity?.digest ?? context.config.imageAddress ?? null,
  host, serverPath, log,
})

if (opened.error) {
  log.error(opened.error)
  log.info('')
  log.info('  Set deploy.journal = false in frontier.config.js to deploy without one.')
  context.config.abort = true
  return
}

// The step runner calls this around every step from here on — that is what turns
// the existing `_steps-docker` list into journal rows without eleven step files
// each learning to write one.
context.config.journal      = opened.recorder
context.config.transitionId = opened.transition.id
context.config.releaseId    = opened.release.id

log.success(`Journal opened → ${opened.release.app} · ${opened.release.environment}`)
log.info(`  release     ${opened.release.id}`)
log.info(`  serving     ${opened.serving ?? '— nothing recorded yet'}`)
log.info(`  transition  ${opened.transition.id}`)

if (opened.resumed) {
  log.warn(`  RESUMING attempt ${opened.attempt} — a previous run did not finish`)
  log.info('  Steps it completed replay into a no-op; a step it died inside runs again.')
} else if (opened.attempt > 1) {
  log.info(`  attempt     ${opened.attempt}`)
}

// ─── What the digest is, and how far it travels ──────────────────────────────
// A term of the id now. What it is NOT yet is portable: building on the target
// produces an image ID, which is true on this host and meaningless on another,
// so two environments on two machines still cannot be shown to run one artefact.
// That is the rest of `2.3f` — a builder with an identity, and the bytes shipped
// rather than rebuilt.
//
// The cost of putting it in the id is that a resume must recompute the same id,
// which means the build has to produce the same digest twice. Docker's cache
// does that for an unchanged tree; where it does not, the resume opens a second
// transition rather than continuing the first, which is honest — different bytes
// are a different Release, and pretending otherwise is what the old ordering did.
if (!opened.release.digest)
  log.info('  digest      — the build recorded none; this Release names no bytes')
```
