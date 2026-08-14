---
title: fixture:sibling-scratch
description: A non-index command that writes context.config — it must exist
---

```js
context.config.touched = true
log.success(`scratch is ${typeof context.config}`)
```
