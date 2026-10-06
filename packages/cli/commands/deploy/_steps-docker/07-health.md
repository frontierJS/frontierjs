---
title: 07-health
description: Health check new container — rolls back to _replaced on failure
skip: "!$.config.doApi"
---

```js
if ($.config.abort) return

const { apiPort, healthPath, container, replaced, imageTag } = $.config
const { host } = $.config.api

const { healthy } = healthOrRestore($, {
  host, container, replaced, apiPort, healthPath, log,
})

if (!healthy) {
  $.config.abort = true
  throw new Error(`Health check failed for ${imageTag} — rolled back`)
}
```
