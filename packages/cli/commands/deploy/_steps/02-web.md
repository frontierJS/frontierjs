---
title: 02-web
description: Deploy the web app
---

```js
if ($.config.abort) return
const { server, serverPath } = $.config
log.info('Deploying web...')
machineFor($, server, serverPath).run(`npm run deploy:web --prefix='${serverPath}'`, { dry: flag.dry })
log.success('Web deployed')
```
