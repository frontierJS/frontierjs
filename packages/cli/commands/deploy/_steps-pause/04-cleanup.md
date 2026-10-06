---
title: 04-cleanup
description: Settle the transition, release the lock, and print what is now in force
runOnAbort: true
---

```js
// ─── Settle first ─────────────────────────────────────────────────────────────
// On BOTH paths. A pause that aborted must leave a `failed` transition and not a
// `running` one, or the next reader sees an open transition and the app reads as
// mid-something rather than as serving.
const settle = async (status) => {
  if (!$.config.journal || !$.config.transitionId) return
  try { await $.config.journal.settle(status) }
  catch (err) { log.warn(`Journal: could not settle the ${$.config.pauseKind} — ${err.message}`) }
}

const dropLocks = async () => {
  if (!$.config.lockAcquired) return
  await releaseLocks($, $.config.hosts ?? [])
  $.config.lockAcquired = false
}

if ($.config.abort) {
  await settle('failed')
  await dropLocks()
  return
}

await settle('succeeded')
await dropLocks()

const { appId, target, pauseKind } = $.config
const elapsed = ((Date.now() - $.config.startTime) / 1000).toFixed(1)

log.success(`${pauseKind === 'pause' ? 'Paused' : 'Unpaused'} ${appId} on ${target} in ${elapsed}s`)
if (pauseKind === 'pause') log.info(`  fli deploy:unpause${target === 'production' ? ' --production' : ''}   lifts it`)
log.info(`  fli deploy:status   shows what the journal and the edge each say`)
```
