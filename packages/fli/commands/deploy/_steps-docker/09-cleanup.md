---
title: 09-cleanup
description: Remove _replaced container, prune old images, release deploy lock
---

```js
if (context.config.abort) {
  // Abnormal exit — still release the lock so the next deploy isn't blocked
  if (context.config.lockAcquired) {
    const { host, serverPath } = context.config
    try {
      context.exec({ command: `ssh ${host} "rm -f ${serverPath}/.deploy.lock"` })
    } catch {}
  }
  return
}

const { host, serverPath, replaced, imageTag, appId } = context.config

// ─── Remove _replaced container ───────────────────────────────────────────────
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

// ─── Release deploy lock ──────────────────────────────────────────────────────
context.exec({ command: `ssh ${host} "rm -f ${serverPath}/.deploy.lock"` })
context.config.lockAcquired = false

// ─── Report ───────────────────────────────────────────────────────────────────
const elapsed = ((Date.now() - context.config.startTime) / 1000).toFixed(1)
log.success(`Deployed ${context.config.commit} to ${context.config.target} in ${elapsed}s`)
```
