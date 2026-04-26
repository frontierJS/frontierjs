---
title: caprover:update
description: Deploy/update a CapRover app from a local directory
alias: cap-update
examples:
  - fli caprover:update
  - fli caprover:update api
  - fli caprover:update web --production
args:
  -
    name: target
    description: Which app to deploy (api, web, etc.)
    defaultValue: api
flags:
  production:
    type: boolean
    description: Deploy to production server
    defaultValue: false
---

```js
const config = flag.production ? '.caprover.config.yml' : '.caprover.dev.config.yml'
const dir    = `${context.paths.root}/${arg.target}`
context.exec({ command: `caprover deploy --configFile ${config} --tarFile ${dir}`, dry: flag.dry })
```
