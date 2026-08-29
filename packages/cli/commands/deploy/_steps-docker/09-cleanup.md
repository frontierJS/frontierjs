---
title: 09-cleanup
description: Remove _replaced container, prune old images, release deploy lock
runOnAbort: true
---

```js
// Every machine the run locked, not just the API's — a split deploy that aborts
// after taking both locks otherwise leaves the web host locked forever.
const dropLocks = () => {
  if (!context.config.lockAcquired) return
  releaseLocks(context, context.config.hosts ?? [])
  context.config.lockAcquired = false
}

// ─── Settle the transition ────────────────────────────────────────────────────
// The journal's last write, and it runs on BOTH paths: a deploy that aborted
// leaves a `failed` transition, not a `running` one that the next run would
// mistake for a crash and try to resume. `runOnAbort: true` on this step is what
// makes that reachable at all.
const settle = async (status) => {
  if (!context.config.journal || !context.config.transitionId) return
  try { await context.config.journal.settle(status) }
  catch (err) { log.warn(`Journal: could not settle the transition — ${err.message}`) }
}

if (context.config.abort) {
  // Abnormal exit — still release the locks so the next deploy isn't blocked
  await settle('failed')
  dropLocks()
  return
}

const { replaced, imageTag, appId } = context.config
const apiSide = context.config.api

// ─── Remove _replaced container ───────────────────────────────────────────────
// Containers and images live on the API host; a web-only run has none.
if (apiSide) {
const machine = machineFor(context, apiSide.host, apiSide.path)

machine.run(`if docker inspect ${replaced} > /dev/null 2>&1; then
  docker stop ${replaced} || true
  docker rm   ${replaced}
fi`)

// ─── Prune dangling images for this app ───────────────────────────────────────
// Removes untagged images — keeps the last deployed tag and any others in use.
machine.run(`docker image prune -f --filter label=app=${appId} 2>/dev/null || true`)
}

// ─── Settle, then release the locks ───────────────────────────────────────────
await settle('succeeded')
dropLocks()

// ─── Report ───────────────────────────────────────────────────────────────────
const elapsed = ((Date.now() - context.config.startTime) / 1000).toFixed(1)
log.success(`Deployed ${context.config.commit} to ${context.config.target} in ${elapsed}s`)
```
