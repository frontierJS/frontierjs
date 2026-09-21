---
title: 01-throws
---

```js
context.config.ran.push('01')
context.config.abort = true
throw new Error('health check failed')
```
