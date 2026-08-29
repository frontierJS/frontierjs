---
title: 08-release-web
description: Point nginx at the new web release via symlink
optional: true
skip: "!context.config.doWeb"
---

```js
if (context.config.abort) return

const { releaseDir } = context.config
const { host, path: serverPath } = context.config.web
const currentLink = `${serverPath}/current`

// Atomic symlink swap — ln -sfn is atomic on Linux
// nginx serves from the symlink, so the cutover is instant
log.info('Updating web release symlink...')
machineFor(context, host, serverPath).run(`ln -sfn ${releaseDir} ${currentLink} && nginx -s reload`)

log.success(`Web live → current → releases/${context.config.commit}`)
```
