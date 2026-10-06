---
title: 08-release-web
description: Point nginx at the new web release via symlink
optional: true
skip: "!$.config.doWeb"
---

```js
if ($.config.abort) return

const { releaseDir } = $.config
const { host, path: serverPath } = $.config.web
const currentLink = `${serverPath}/current`

// Atomic symlink swap — ln -sfn is atomic on Linux
// nginx serves from the symlink, so the cutover is instant
log.info('Updating web release symlink...')
machineFor($, host, serverPath).run(`ln -sfn ${releaseDir} ${currentLink} && nginx -s reload`)

log.success(`Web live → current → releases/${$.config.commit}`)
```
