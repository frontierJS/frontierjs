---
title: 08-release-web
description: Point the edge at the new web release via symlink
optional: true
skip: "!$.config.doWeb"
---

```js
if ($.config.abort) return

const { releaseDir } = $.config
const { host, path: serverPath } = $.config.web
const currentLink = `${serverPath}/current`

// ln -sfn is atomic on Linux, and Caddy resolves the root per request, so the
// swap is the whole cutover — there is nothing to reload.
log.info('Updating web release symlink...')
machineFor($, host, serverPath).run(`ln -sfn ${releaseDir} ${currentLink}`)

log.success(`Web live → current → releases/${$.config.commit}`)
```
