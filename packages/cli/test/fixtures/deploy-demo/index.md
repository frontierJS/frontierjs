---
title: fixture:deploy
description: Deploy fixture for tests
alias: fixture-deploy
flags:
  env:
    type: string
    defaultValue: staging
  branch:
    type: string
    defaultValue: main
---

```js
$.config.env    = flag.env
$.config.branch = flag.branch
log.info(`Deploying ${$.config.branch} → ${$.config.env}`)
```
