---
title: 03-finish
description: Report deploy time
---

```js
if (context.config.abort) return
const elapsed = ((Date.now() - context.config.startTime) / 1000).toFixed(1)
log.success(`Deployed to ${context.config.target} in ${elapsed}s`)
```
