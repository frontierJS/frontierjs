---
title: 01-validate
---

```js
const { env, branch } = context.config
log.success(`Environment: ${env}`)
log.success(`Branch:      ${branch}`)
context.config.validated = true
```
