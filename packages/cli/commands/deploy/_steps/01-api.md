---
title: 01-api
description: Deploy the API
---

```js
if ($.config.abort) return
const { server, serverPath } = $.config
log.info('Deploying API...')
machineFor($, server, serverPath).run(`npm run deploy:api --prefix='${serverPath}'`, { dry: flag.dry })
log.success('API deployed')
```
