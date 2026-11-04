---
title: 09-cleanup
description: Prune old images, release deploy lock
runOnAbort: true
---

```js
// Every machine the run locked, not just the API's — a split deploy that aborts
// after taking both locks otherwise leaves the web host locked forever.
const dropLocks = async () => {
  if (!$.config.lockAcquired) return
  await releaseLocks($, $.config.hosts ?? [])
  $.config.lockAcquired = false
}

// ─── Settle the transition ────────────────────────────────────────────────────
// The journal's last write, and it runs on BOTH paths: a deploy that aborted
// leaves a `failed` transition, not a `running` one that the next run would
// mistake for a crash and try to resume. `runOnAbort: true` on this step is what
// makes that reachable at all.
const settle = async (status) => {
  if (!$.config.journal || !$.config.transitionId) return
  try { await $.config.journal.settle(status) }
  catch (err) { log.warn(`Journal: could not settle the transition — ${err.message}`) }
}

if ($.config.abort) {
  // Abnormal exit — still release the locks so the next deploy isn't blocked
  await settle('failed')
  await dropLocks()
  return
}

const { imageTag, appId } = $.config
const apiSide = $.config.api

// ─── Prune dangling images for this app ───────────────────────────────────────
// Images live on the API host; a web-only or site-only run has none. The
// `_replaced` container is gone already: the swap removes it once the new one
// answers (`FJS-D1866`).
if (apiSide && !$.config.siteOnly) {
const machine = machineFor($, apiSide.host, apiSide.path)

// Removes untagged images — keeps the last deployed tag and any others in use.
machine.run(`docker image prune -f --filter label=app=${appId} 2>/dev/null || true`)
}

// ─── Settle, then release the locks ───────────────────────────────────────────
await settle('succeeded')
await dropLocks()

// ─── Report ───────────────────────────────────────────────────────────────────
const elapsed = ((Date.now() - $.config.startTime) / 1000).toFixed(1)
log.success(`Deployed ${$.config.commit} to ${$.config.target} in ${elapsed}s`)
const slowest = [...($.config.stepTimes ?? [])].sort((a, b) => b.ms - a.ms).slice(0, 3)
if (slowest.length) log.info(`  slowest: ${slowest.map(t => `${t.step} ${(t.ms / 1000).toFixed(1)}s`).join(' · ')}`)
```
