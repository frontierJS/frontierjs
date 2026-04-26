---
title: 02-web
description: Deploy the web app
---

```js
if (context.config.abort) return
const { server, serverPath } = context.config
log.info('Deploying web...')
context.exec({
  command: `ssh ${server} "npm run deploy:web --prefix='${serverPath}'"`,
  dry: flag.dry
})
log.success('Web deployed')
```
