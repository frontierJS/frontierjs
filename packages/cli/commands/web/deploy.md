---
title: web:deploy
description: Deploy the web app to a remote server via SSH
alias: web-deploy
examples:
  - fli web:deploy
  - fli web:deploy --production
  - fli web:deploy --stage
  - fli web:deploy --dry
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

Deploys the web app over SSH. Make sure you've built first (`fli web:build`).

Requires a `captain-definition` file in the web directory and a configured
`.caprover.yml`. Environment is resolved from flags, then falls back to dev.

```js
const env = context.env
let server, serverPath

if (flag.production) {
  server     = env.PROD_SERVER
  serverPath = env.PROD_SERVER_PATH
} else if (flag.stage || context.git.branch() === 'stage') {
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

log.info(`Deploying web to ${server}...`)
const before = Date.now()
context.exec({
  command: `ssh ${server} "npm run deploy:web --prefix='${serverPath}'"`,
  dry: flag.dry
})
const elapsed = ((Date.now() - before) / 1000).toFixed(1)
if (!flag.dry) log.success(`Done in ${elapsed}s`)
```
