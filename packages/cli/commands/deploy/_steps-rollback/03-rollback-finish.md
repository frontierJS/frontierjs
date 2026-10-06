---
title: 03-rollback-finish
description: Report rollback result
---

```js
if ($.config.abort) return

const elapsed = ((Date.now() - $.config.startTime) / 1000).toFixed(1)
log.success(`Rollback complete for ${$.config.appId} (${$.config.target}) in ${elapsed}s`)
```
