---
title: caprover:create
description: Register a new app on a CapRover server
alias: cap-create
examples:
  - fli caprover:create api
  - fli caprover:create web --production
  - fli caprover:create api --persistent-db
args:
  -
    name: target
    description: Project folder containing .caprover.yml (api or web)
    required: true
flags:
  production:
    type: boolean
    description: Target the production server
    defaultValue: false
  persistent-db:
    char: p
    type: boolean
    description: Enable persistent storage for this app
    defaultValue: false
---

```js
const suffix = flag.production ? '.yml' : '.dev.yml'
const config = `${context.paths.root}/${arg.target}/.caprover${suffix}`

context.exec({
  command: `caprover api --configFile ${config} --path /user/apps/appDefinitions/register --method POST`,
  dry: flag.dry
})
```
