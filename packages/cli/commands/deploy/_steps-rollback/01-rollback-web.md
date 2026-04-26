---
title: 01-rollback-web
description: Point current symlink at the previous web release
optional: true
skip: "!context.config.doWeb || context.config.deployConf.web === false"
---

```js
if (context.config.abort) return

const { host, serverPath } = context.config

// List releases newest-first — second entry is the previous release
const listCmd = `ls -1dt ${serverPath}/releases/* 2>/dev/null | head -2`
let releases = ''
try {
  const result = context.exec({ command: `ssh ${host} "${listCmd}"`, stdio: 'pipe' })
  releases = result?.toString('utf8').trim() ?? ''
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

context.exec({
  command: `ssh ${host} "ln -sfn ${previous} ${serverPath}/current && nginx -s reload"`,
  dry: flag.dry,
})

context.config.webRolledBack = true
log.success(`Web rolled back → releases/${prevName}`)
```
