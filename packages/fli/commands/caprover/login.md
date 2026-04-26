---
title: caprover:login
description: Log in to a CapRover server
alias: cap-login
examples:
  - fli caprover:login
  - fli caprover:login --production
flags:
  production:
    type: boolean
    description: Log in to the production server
    defaultValue: false
---

```js
const config = flag.production ? '.caprover.config.yml' : '.caprover.dev.config.yml'
context.exec({ command: `caprover login --configFile ${config}`, dry: flag.dry })
```
