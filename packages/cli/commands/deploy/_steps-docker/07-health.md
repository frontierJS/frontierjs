---
title: 07-health
description: Health check new container — rolls back to _replaced on failure
skip: "!context.config.doApi"
---

```js
if (context.config.abort) return

const { apiPort, healthPath, container, replaced, imageTag } = context.config
const { host } = context.config.api
const attempts = 10
const intervalS = 2

// Poll the health endpoint — new container may take a moment to boot
log.info(`Waiting for ${healthPath} (up to ${attempts * intervalS}s)...`)

const healthCmd = `
  for i in $(seq 1 ${attempts}); do
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:${apiPort}${healthPath} 2>/dev/null)
    if [ "$STATUS" = "200" ]; then
      echo "ok"
      exit 0
    fi
    sleep ${intervalS}
  done
  echo "fail"
  exit 1
`.trim().replace(/\n\s*/g, '; ')

let healthy = false
try {
  context.exec({ command: `ssh ${host} "${healthCmd}"` })
  healthy = true
} catch {
  healthy = false
}

if (!healthy) {
  // ── Rollback ────────────────────────────────────────────────────────────────
  // Name the URL. The most common cause is not a sick app but a health path that
  // omits the app's apiPrefix — healthPlugin() registers through app.get(), which
  // moves with the prefix, so an app serving /api/health polls 404 here and a
  // working release gets reverted. Without the URL in the message that reads as
  // the app's fault.
  log.error(`Health check failed after ${attempts * intervalS}s — rolling back`)
  log.error(`  polled: http://localhost:${apiPort}${healthPath}`)
  log.info(`  if the API is healthy, check deploy.api.health includes your apiPrefix`)

  const rollbackCmd = `
    docker stop ${container} || true;
    docker rm   ${container} || true;
    if docker inspect ${replaced} > /dev/null 2>&1; then
      docker rename ${replaced} ${container};
      docker start  ${container};
      echo "rolled back"
    else
      echo "no previous container to restore"
    fi
  `.trim().replace(/\n\s*/g, '; ')

  try {
    context.exec({ command: `ssh ${host} "${rollbackCmd}"` })
    log.warn('Rolled back to previous container')
  } catch (rollbackErr) {
    log.error('Rollback also failed: ' + rollbackErr.message)
  }

  context.config.abort = true
  throw new Error(`Health check failed for ${imageTag} — rolled back`)
}

log.success('Health check passed')
```
