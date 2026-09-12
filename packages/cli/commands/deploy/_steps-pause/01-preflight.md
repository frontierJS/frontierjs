---
title: 01-preflight
description: Reach the machine, find the guard, take the lock, and open the transition
---

```js
if (context.config.abort) return

const { host, serverPath, appId, target, deployConf, pauseKind } = context.config
const { GUARD_MARKER, vhostPath, pausedFile } =
  await import(new URL('file://' + global.fliRoot + '/core/pause.js'))

const machine = machineFor(context, host, serverPath)
log.info(`Checking ${machine.kind === 'local' ? 'the local machine' : `SSH → ${host}`}`)
if (!machine.reach()) {
  log.error(`Cannot reach ${host} — check your SSH key and server address`)
  context.config.abort = true
  return
}

// Is the guard in the vhost at all? A target set up before this existed has a
// working config with nothing in it that reads the file, so a pause would write
// a file nothing stats and report success — which is the failure this whole
// phase is about, one layer along. Grep for the marker rather than for the shape
// of the guard: the alternative to finding it is `sed` against a live config.
const vhost = vhostPath(appId)
context.config.vhostHasGuard =
  machine.capture(`grep -qF '${GUARD_MARKER}' ${vhost} 2>/dev/null && echo yes || echo no`).trim() === 'yes'

// What is in force right now, which the journal cannot tell us — the two are
// compared rather than trusted, and `04-cleanup` prints the pair.
context.config.fileWasPresent =
  machine.capture(`[ -f ${pausedFile(serverPath)} ] && echo yes || echo no`).trim() === 'yes'

// The SAME lock a deploy takes. Two operators, one pausing and one deploying, is
// exactly the race it exists for.
log.info('Acquiring deploy lock...')
const lock = await acquireLock(context, { hosts: context.config.hosts, target })
if (!lock.ok) {
  for (const [level, line] of await lockRefusal(lock, { verb: pauseKind })) log[level](line)
  context.config.abort = true
  return
}
context.config.lockAcquired = true

const opened = await openPauseJournal(context, context.flag, {
  kind: pauseKind, host, serverPath, deployConf, target, stepsDir: '_steps-pause', log,
  // Both answers, because `already` is graded on the pair. A journal that says
  // paused over a target whose file somebody removed must accept another pause,
  // and a journal that says serving over a target somebody paused by hand must
  // accept an unpause — which is the only way a hand-made pause gets recorded.
  vhostHasGuard: context.config.vhostHasGuard,
  filePresent:   context.config.fileWasPresent,
})

if (opened.error) {
  log.error(opened.error)
  context.config.abort = true
  return
}

if (opened.refused) {
  log.error(`Cannot ${pauseKind} ${appId} on ${target}:`)
  for (const r of opened.refused) {
    log.error(`  ${r.code}: ${r.reason}`)
    if (r.fix) log.info(`    ${r.fix}`)
  }
  context.config.abort = true
  return
}

context.config.journal      = opened.recorder
context.config.transitionId = opened.transition.id
context.config.servingState = opened.state

log.success(`Journal opened → ${appId} · ${target}`)
log.info(`  serving     ${opened.state.serving}`)
log.info(`  transition  ${opened.transition.id}`)
```
