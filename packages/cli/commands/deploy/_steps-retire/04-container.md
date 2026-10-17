---
title: 04-container
description: Remove the API container, the one a deploy left _replaced, and every image of the app
---

```js
if ($.config.abort) return

const { appId, deployConf } = $.config
const { host, path } = $.config.api
const container = apiContainer(appId, deployConf)

// An image is tagged `<appId>:<sha>` by 02-ship, so the repository name is
// every release this machine built.
machineFor($, host, path).run(`docker rm -f ${container} ${container}_replaced >/dev/null 2>&1 || true
docker images -q ${appId} | sort -u | xargs -r docker rmi -f >/dev/null 2>&1 || true`)
log.success(`  Container and images removed → ${host}`)
```
