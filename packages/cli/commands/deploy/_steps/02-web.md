---
title: 02-web
description: Deploy the web app
---

```js
if (context.config.abort) return
const { server, serverPath } = context.config
log.info('Deploying web...')
machineFor(context, server, serverPath).run(`npm run deploy:web --prefix='${serverPath}'`, { dry: flag.dry })
log.success('Web deployed')
```
