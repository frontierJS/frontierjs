---
title: 05-cleanup
description: Settle the revert, remove the replaced container, release the lock
runOnAbort: true
---

```js
// ─── Settle first ─────────────────────────────────────────────────────────────
// On BOTH paths, and before anything else here: a revert that aborted must leave
// a `failed` transition rather than a `running` one, or the next run reads it as
// a crash worth resuming and offers to redo a revert nobody completed.
const settle = async (status) => {
  if (!context.config.journal || !context.config.transitionId) return
  try { await context.config.journal.settle(status) }
  catch (err) { log.warn(`Journal: could not settle the revert — ${err.message}`) }
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

// ─── Remove the container this revert replaced ────────────────────────────────
// It is the release that WAS serving. Keeping it would leave a `_replaced` handle
// that the next revert's health step could restore by accident.
const { host, replaced } = context.config
if (replaced) {
  try {
    machineFor(context, host).run(`if docker inspect ${replaced} > /dev/null 2>&1; then
  docker stop ${replaced} || true
  docker rm   ${replaced}
fi`)
  } catch {}
}

await dropLocks()

const elapsed = ((Date.now() - context.config.startTime) / 1000).toFixed(1)
log.success(`Reverted ${context.config.appId} to ${context.config.revertTo?.id} in ${elapsed}s`)
log.info(`  fli deploy:journal --steps   shows what this wrote`)
```
