---
title: 04-build-api
description: Build Docker image on the server
---

```js
if (context.config.abort) return

const { host, serverPath, imageTag, deployConf } = context.config
const dockerfile = deployConf.api?.dockerfile ?? 'api/deploy/Dockerfile'

log.info(`Building image ${imageTag}...`)
context.exec({
  command: `ssh ${host} "cd ${serverPath} && docker build -t ${imageTag} -f ${dockerfile} ."`,
})

log.success(`Image built → ${imageTag}`)
```
