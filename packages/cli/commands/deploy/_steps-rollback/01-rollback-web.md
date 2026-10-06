---
title: 01-rollback-web
description: Point current symlink at the previous web release
optional: true
skip: "!$.config.doWeb || $.config.deployConf.web === false"
---

```js
if ($.config.abort) return

const { host, serverPath } = $.config
const machine = machineFor($, host, serverPath)

// List releases newest-first — second entry is the previous release
let releases = ''
try {
  releases = machine.capture(`ls -1dt ${serverPath}/releases/* 2>/dev/null | head -2`)
} catch {
  releases = ''
}

const releaseList = releases.split('\n').filter(Boolean)

if (releaseList.length < 2) {
  log.warn('No previous web release found — skipping web rollback')
  log.info(`Only ${releaseList.length} release(s) exist on the server`)
  return
}

const previous = releaseList[1]
const current  = releaseList[0]
const prevName = previous.split('/').pop()
const currName = current.split('/').pop()

log.info(`Rolling web back: ${currName} → ${prevName}`)

machine.run(`ln -sfn ${previous} ${serverPath}/current`, { dry: flag.dry })

$.config.webRolledBack = true
log.success(`Web rolled back → releases/${prevName}`)
```
