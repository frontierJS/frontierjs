---
title: 08-release-web
description: Point nginx at the new web release via symlink
optional: true
skip: "context.config.deployConf.web === false"
---

```js
if (context.config.abort) return

const { host, serverPath, releaseDir } = context.config
const currentLink = `${serverPath}/current`

// Atomic symlink swap — ln -sfn is atomic on Linux
// nginx serves from the symlink, so the cutover is instant
log.info('Updating web release symlink...')
context.exec({
  command: `ssh ${host} "ln -sfn ${releaseDir} ${currentLink} && nginx -s reload"`,
})

log.success(`Web live → current → releases/${context.config.commit}`)
```
