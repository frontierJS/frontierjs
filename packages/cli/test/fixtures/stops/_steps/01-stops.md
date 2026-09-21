---
title: 01-stops
---

```js
context.config.ran.push('01')
log.info('--plan: nothing was written or run.')
// `stop`, not `abort`: what was asked for happened.
context.config.stop = true
```
