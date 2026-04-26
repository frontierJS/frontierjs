---
title: utils:ssh
description: SSH into a project server (dev, stage, or production)
alias: ssh
examples:
  - fli ssh
  - fli ssh --production
  - fli ssh --stage
  - fli ssh --dry
flags:
  production:
    type: boolean
    description: SSH into the production server
    defaultValue: false
  stage:
    type: boolean
    description: SSH into the stage server
    defaultValue: false
---

```js
const env = context.env
let server

if (flag.production) {
  server = env.PROD_SERVER
} else if (flag.stage) {
  server = env.STAGE_SERVER
} else {
  server = env.DEV_SERVER
}

if (!server) {
  log.error('No server configured — set DEV_SERVER / STAGE_SERVER / PROD_SERVER in .env')
  return
}

log.info(`Connecting to ${server}...`)
context.exec({ command: `ssh ${server}`, dry: flag.dry })
```
