---
title: 08-release-web
description: Point the edge at the new web release via symlink
optional: true
skip: "!$.config.doWeb"
---

```js
const { releaseDir } = $.config
const { host, path: serverPath } = $.config.web
const currentLink = `${serverPath}/current`

// 03-build-web is optional too, and sets releaseDir only when it lands. Linked
// unread, a failed build points current at "undefined" and takes down the page
// that was serving (FJS-3588).
if (!releaseDir) {
  log.error(`No web release was built — ${currentLink} left on the release it names`)
  $.config.abort = true
  return
}

// ln -sfn is atomic on Linux, and Caddy resolves the root per request, so the
// swap is the whole cutover — there is nothing to reload.
log.info('Updating web release symlink...')
machineFor($, host, serverPath).run(`ln -sfn ${releaseDir} ${currentLink}`)

log.success(`Web live → current → releases/${$.config.commit}`)
```
