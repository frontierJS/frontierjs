---
title: 07-health
description: Health check new container — rolls back to _replaced on failure
skip: "!context.config.doApi"
---

```js
if (context.config.abort) return

const { apiPort, healthPath, container, replaced, imageTag } = context.config
const { host } = context.config.api

const { healthy } = healthOrRestore(context, {
  host, container, replaced, apiPort, healthPath, log,
})

if (!healthy) {
  context.config.abort = true
  throw new Error(`Health check failed for ${imageTag} — rolled back`)
}
```
