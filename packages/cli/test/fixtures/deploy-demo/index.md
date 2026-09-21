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
context.config.env    = flag.env
context.config.branch = flag.branch
log.info(`Deploying ${context.config.branch} → ${context.config.env}`)
```
