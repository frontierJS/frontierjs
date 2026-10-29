---
title: 07-health
description: Health check new container — rolls back to _replaced on failure
skip: "!$.config.doApi"
---

```js
const { apiPort, healthPath, container, replaced, imageTag } = $.config
const { host } = $.config.api

const { healthy, none, unbound } = await healthOrRestore($, {
  host, container, replaced, apiPort, healthPath, log,
})

if (!healthy) {
  $.config.abort = true
  const after = none ? 'removed, nothing was serving before it' : 'rolled back'
  throw new Error(unbound.length
    ? `${imageTag} opened ${unbound.join(', ')} outside the volume — ${after}`
    : `Health check failed for ${imageTag} — ${after}`)
}
```
