---
title: 08-release-widgets
description: Point the widget origin at the new release via symlink
optional: true
skip: "!$.config.doWidgets"
---

```js
const { widgetsReleaseDir, host, serverPath, deployConf } = $.config
const currentLink = `${widgetsPathOf(deployConf, serverPath)}/current`

// 03b-build-widgets sets widgetsReleaseDir only when it lands. Linked unread, a
// failed build points current at "undefined" and takes the origin down (FJS-3588).
if (!widgetsReleaseDir) {
  log.error(`No widgets release was built -- ${currentLink} left on the release it names`)
  $.config.abort = true
  return
}

// The same atomic swap as web: Caddy resolves the root per request.
log.info('Updating widgets release symlink...')
machineFor($, host, serverPath).run(`ln -sfn ${widgetsReleaseDir} ${currentLink}`)

log.done(`Widgets live → current → releases/${$.config.commit}`)
```
