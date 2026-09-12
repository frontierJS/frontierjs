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
  if (!context.config.journal || !context.config.transitionId) return
  try { await context.config.journal.settle(status) }
  catch (err) { log.warn(`Journal: could not settle the ${context.config.pauseKind} — ${err.message}`) }
}

const dropLocks = async () => {
  if (!context.config.lockAcquired) return
  await releaseLocks(context, context.config.hosts ?? [])
  context.config.lockAcquired = false
}

if (context.config.abort) {
  await settle('failed')
  await dropLocks()
  return
}

await settle('succeeded')
await dropLocks()

const { appId, target, pauseKind } = context.config
const elapsed = ((Date.now() - context.config.startTime) / 1000).toFixed(1)

log.success(`${pauseKind === 'pause' ? 'Paused' : 'Unpaused'} ${appId} on ${target} in ${elapsed}s`)
if (pauseKind === 'pause') log.info(`  fli deploy:unpause${target === 'production' ? ' --production' : ''}   lifts it`)
log.info(`  fli deploy:status   shows what the journal and the edge each say`)
```
