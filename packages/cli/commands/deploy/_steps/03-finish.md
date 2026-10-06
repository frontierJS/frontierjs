---
title: 03-finish
description: Report deploy time
---

```js
if ($.config.abort) return
const elapsed = ((Date.now() - $.config.startTime) / 1000).toFixed(1)
log.success(`Deployed to ${$.config.target} in ${elapsed}s`)
```
