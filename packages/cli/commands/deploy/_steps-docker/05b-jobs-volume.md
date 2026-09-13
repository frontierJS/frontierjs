---
title: 05b-jobs-volume
description: Ask the running container where its jobs database is, before the swap discards it
skip: "!context.config.doApi"
---

```js
if (context.config.abort) return

const { appId, deployConf } = context.config
const { host, path: serverPath } = context.config.api
const { queueScript, jobsVolumeVerdict } = await import(new URL('file://' + global.fliRoot + '/core/pause.js'))

// BEFORE 06-swap, against the container being replaced: it is the only thing
// that knows which file it opened, and after the swap the answer is an empty
// file. Asked of Caravan's own bin, so an app that sets the path in code is read
// the same as one that sets it in config. No container, no Caravan and no open
// database each say nothing.
const output  = machineFor(context, host, serverPath).capture(
  queueScript({ container: apiContainer(appId, deployConf), verb: 'state' }))
const verdict = jobsVolumeVerdict({ output, volume: CONTAINER_DB_DIR })

if (verdict.level === 'ok') return
const say = verdict.level === 'fail' ? 'error' : 'warn'
for (const line of verdict.lines) log[say](line)

if (verdict.level === 'fail') {
  context.config.abort = true
  throw new Error('the jobs database is not on the volume and a pause is in force')
}
```
