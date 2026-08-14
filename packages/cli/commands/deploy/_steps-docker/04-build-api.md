---
title: 04-build-api
description: Build Docker image on the server
skip: "!context.config.doApi"
---

```js
if (context.config.abort) return

const { imageTag, deployConf } = context.config
const { host, path: serverPath } = context.config.api
const dockerfile = deployConf.api?.dockerfile ?? 'deploy/Dockerfile'

log.info(`Building image ${imageTag}...`)
context.exec({
  command: `ssh ${host} "cd ${serverPath} && docker build -t ${imageTag} -f ${dockerfile} ."`,
})

log.success(`Image built → ${imageTag}`)
```
