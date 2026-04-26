---
title: 03-rollback-finish
description: Report rollback result
---

```js
if (context.config.abort) return

const elapsed = ((Date.now() - context.config.startTime) / 1000).toFixed(1)
log.success(`Rollback complete for ${context.config.appId} (${context.config.target}) in ${elapsed}s`)
```
