---
title: caprover:backup
description: Trigger a CapRover app backup
alias: cap-backup
examples:
  - fli caprover:backup
  - fli caprover:backup --production
flags:
  production:
    type: boolean
    description: Run against the production server
    defaultValue: false
---

```js
const config = flag.production ? '.caprover.config.yml' : '.caprover.dev.config.yml'
context.exec({ command: `caprover api --configFile ${config} --path /user/apps/appDefinitions/backup --method POST`, dry: flag.dry })
```
