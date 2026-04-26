---
title: caprover:ssl
description: Enable or force-renew SSL on a CapRover app
alias: cap-ssl
examples:
  - fli caprover:ssl
  - fli caprover:ssl --production
flags:
  production:
    type: boolean
    description: Run against the production server
    defaultValue: false
  app:
    char: a
    type: string
    description: App name to enable SSL for
    defaultValue: ''
---

```js
const config = flag.production ? '.caprover.config.yml' : '.caprover.dev.config.yml'
const appName = flag.app || context.env.CAPROVER_APP_NAME || ''
if (!appName) { log.error('Provide --app or set $CAPROVER_APP_NAME in .env'); return }
context.exec({
  command: `caprover api --configFile ${config} --path /user/apps/appDefinitions/${appName} --method POST --data '{"forceSsl":true}'`,
  dry: flag.dry
})
```
