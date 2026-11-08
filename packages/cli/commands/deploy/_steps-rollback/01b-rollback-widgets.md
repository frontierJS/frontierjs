---
title: 01b-rollback-widgets
description: Point the widget origin's current symlink at the previous release
optional: true
skip: "!$.config.doWidgets"
---

```js
const { host, serverPath, deployConf } = $.config
const widgetsPath = widgetsPathOf(deployConf, serverPath)
const machine     = machineFor($, host, serverPath)

let releases = ''
try {
  releases = machine.capture(`ls -1dt ${widgetsPath}/releases/* 2>/dev/null | head -2`)
} catch {
  log.error(`Lost ${host} -- widgets were not rolled back`)
  $.config.abort = true
  return
}

const [current, previous] = releases.split('\n').filter(Boolean)
if (!previous) {
  log.warn('No previous widgets release found -- skipping widgets rollback')
  return
}

log.info(`Rolling widgets back: ${current.split('/').pop()} → ${previous.split('/').pop()}`)
machine.run(`ln -sfn ${previous} ${widgetsPath}/current`, { dry: flag.dry })

log.done(`Widgets rolled back → releases/${previous.split('/').pop()}`)
```
