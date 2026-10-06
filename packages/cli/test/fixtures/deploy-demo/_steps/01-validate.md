---
title: 01-validate
---

```js
const { env, branch } = $.config
log.success(`Environment: ${env}`)
log.success(`Branch:      ${branch}`)
$.config.validated = true
```
