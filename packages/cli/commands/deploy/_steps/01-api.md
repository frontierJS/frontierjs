---
title: 01-api
description: Deploy the API
---

```js
if (context.config.abort) return
const { server, serverPath } = context.config
log.info('Deploying API...')
context.exec({
  command: `ssh ${server} "npm run deploy:api --prefix='${serverPath}'"`,
  dry: flag.dry
})
log.success('API deployed')
```
