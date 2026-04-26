---
title: api:deploy
description: Deploy the API via SSH
alias: api-deploy
examples:
  - fli api:deploy
  - fli api:deploy --production
  - fli api:deploy --dry
flags:
  production:
    type: boolean
    description: Deploy to production environment
    defaultValue: false
  stage:
    type: boolean
    description: Deploy to stage environment
    defaultValue: false
---

<script>
import { execSync } from 'child_process'
</script>

```js
const env = context.env
let server, serverPath

if (flag.production) {
  server     = env.PROD_SERVER
  serverPath = env.PROD_SERVER_PATH
} else if (flag.stage) {
  server     = env.STAGE_SERVER
  serverPath = env.STAGE_SERVER_PATH
} else {
  server     = env.DEV_SERVER
  serverPath = env.DEV_SERVER_PATH
}

if (!server) {
  log.error('No server configured — set DEV_SERVER / PROD_SERVER in .env')
  return
}

log.info(`Deploying API to ${server}...`)
const before = Date.now()
context.exec({
  command: `ssh ${server} "npm run deploy:api --prefix='${serverPath}'"`,
  dry: flag.dry
})
const elapsed = ((Date.now() - before) / 1000).toFixed(1)
if (!flag.dry) log.success(`Done in ${elapsed}s`)
```
