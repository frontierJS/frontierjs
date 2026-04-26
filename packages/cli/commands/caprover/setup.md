---
title: caprover:setup
description: Run CapRover server setup wizard
alias: cap-setup
examples:
  - fli caprover:setup
  - fli caprover:setup --production
flags:
  production:
    type: boolean
    description: Set up the production server
    defaultValue: false
---

```js
const config = flag.production ? '.caprover.config.yml' : '.caprover.dev.config.yml'
context.exec({
  command: `caprover serversetup --assumeYes --configFile ${config}`,
  dry: flag.dry
})
```
