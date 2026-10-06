---
title: fixture:sibling-scratch
description: A non-index command that writes $.config — it must exist
---

```js
$.config.touched = true
log.success(`scratch is ${typeof $.config}`)
```
