---
title: 04-health
description: Health check the restored container — puts the current one back if it does not answer
---

```js
if (context.config.abort) return

const { apiPort, healthPath, container, replaced, revertImage, host } = context.config

// The same function the deploy's health step calls, so a revert's safety net is
// the deploy's safety net rather than a copy of it.
const { healthy, restored } = healthOrRestore(context, {
  host, container, replaced, apiPort, healthPath, log,
})

if (!healthy) {
  // Worth saying plainly: the release being restored did not come up, so the one
  // that was serving is back. That is a revert which did not happen — not a
  // deploy that failed — and the journal records it as such.
  log.error(`Revert to ${revertImage} did not come up`)
  if (restored) log.warn('  The release that was serving is running again.')
  else          log.error('  Nothing is serving — restore by hand.')
  context.config.abort = true
  throw new Error(`Revert failed health check for ${revertImage}`)
}
```
