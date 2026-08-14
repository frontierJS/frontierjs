---
title: 09-cleanup
description: Remove _replaced container, prune old images, release deploy lock
runOnAbort: true
---

```js
// Every machine the run locked, not just the API's — a split deploy that aborts
// after taking both locks otherwise leaves the web host locked forever.
const releaseLocks = () => {
  if (!context.config.lockAcquired) return
  for (const h of context.config.hosts ?? []) {
    try { context.exec({ command: `ssh ${h.host} "rm -f ${h.path}/.deploy.lock"` }) } catch {}
  }
  context.config.lockAcquired = false
}

if (context.config.abort) {
  // Abnormal exit — still release the locks so the next deploy isn't blocked
  releaseLocks()
  return
}

const { replaced, imageTag, appId } = context.config
const apiSide = context.config.api

// ─── Remove _replaced container ───────────────────────────────────────────────
// Containers and images live on the API host; a web-only run has none.
if (apiSide) {
const host = apiSide.host
const removeCmd = `
  if docker inspect ${replaced} > /dev/null 2>&1; then
    docker stop ${replaced} || true;
    docker rm   ${replaced}
  fi
`.trim().replace(/\n\s*/g, '; ')

context.exec({ command: `ssh ${host} "${removeCmd}"` })

// ─── Prune dangling images for this app ───────────────────────────────────────
// Removes untagged images — keeps the last deployed tag and any others in use.
context.exec({
  command: `ssh ${host} "docker image prune -f --filter label=app=${appId} 2>/dev/null || true"`,
})
}

// ─── Release deploy locks ─────────────────────────────────────────────────────
releaseLocks()

// ─── Report ───────────────────────────────────────────────────────────────────
const elapsed = ((Date.now() - context.config.startTime) / 1000).toFixed(1)
log.success(`Deployed ${context.config.commit} to ${context.config.target} in ${elapsed}s`)
```
