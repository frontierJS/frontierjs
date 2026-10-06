---
title: 01-preflight
description: Reach the machine, find the guard, take the lock, and open the transition
---

```js
if ($.config.abort) return

const { host, serverPath, appId, target, deployConf, pauseKind } = $.config
const { guardProbeScript, pausedFile } =
  await import(new URL('file://' + global.fliRoot + '/core/pause.js'))

const machine = machineFor($, host, serverPath)
log.info(`Checking ${machine.kind === 'local' ? 'the local machine' : `SSH → ${host}`}`)
if (!machine.reach()) {
  log.error(`Cannot reach ${host} — check your SSH key and server address`)
  $.config.abort = true
  return
}

// Does Caddy hold the guard at all? Routes nobody wrote through deploy:setup
// read no file, so a pause would write a file nothing stats and report success —
// which is the failure this whole phase is about, one layer along. Asked by the
// guard's id rather than the shape of the route: the alternative to finding it
// is editing a live config.
$.config.edgeHasGuard = machine.capture(guardProbeScript(appId)).trim() === '200'

// What is in force right now, which the journal cannot tell us — the two are
// compared rather than trusted, and `04-cleanup` prints the pair.
$.config.fileWasPresent =
  machine.capture(`[ -f ${pausedFile(serverPath)} ] && echo yes || echo no`).trim() === 'yes'

// The SAME lock a deploy takes. Two operators, one pausing and one deploying, is
// exactly the race it exists for.
log.info('Acquiring deploy lock...')
const lock = await acquireLock($, { hosts: $.config.hosts, target })
if (!lock.ok) {
  for (const [level, line] of await lockRefusal(lock, { verb: pauseKind })) log[level](line)
  $.config.abort = true
  return
}
$.config.lockAcquired = true

const opened = await openPauseJournal($, $.flag, {
  kind: pauseKind, host, serverPath, deployConf, target, stepsDir: '_steps-pause', log,
  // Both answers, because `already` is graded on the pair. A journal that says
  // paused over a target whose file somebody removed must accept another pause,
  // and a journal that says serving over a target somebody paused by hand must
  // accept an unpause — which is the only way a hand-made pause gets recorded.
  edgeHasGuard:  $.config.edgeHasGuard,
  filePresent:   $.config.fileWasPresent,
})

if (opened.error) {
  log.error(opened.error)
  $.config.abort = true
  return
}

if (opened.refused) {
  log.error(`Cannot ${pauseKind} ${appId} on ${target}:`)
  for (const r of opened.refused) {
    log.error(`  ${r.code}: ${r.reason}`)
    if (r.fix) log.info(`    ${r.fix}`)
  }
  $.config.abort = true
  return
}

$.config.journal      = opened.recorder
$.config.transitionId = opened.transition.id
$.config.servingState = opened.state

log.success(`Journal opened → ${appId} · ${target}`)
log.info(`  serving     ${opened.state.serving}`)
log.info(`  transition  ${opened.transition.id}`)
```
