---
title: 02a-queues-resume
description: Resume the queues a deploy paused, before the edge serves again
skip: "context.config.pauseKind !== 'unpause'"
---

```js
if (context.config.abort) return

const { host, serverPath, appId, deployConf } = context.config
const { queueScript, queueVerdict } = await import(new URL('file://' + global.fliRoot + '/core/pause.js'))

// Before the edge (FJS-D262), the reverse of the pause. The resume states the
// deploy's holder, so a pause an operator put on the queues is not lifted by it.
log.info('Resuming the queues a deploy paused...')
const output = machineFor(context, host, serverPath).capture(queueScript({
  container: apiContainer(appId, deployConf),
  verb:      'resume',
  actor:     context.git.user?.() ?? null,
}))

const verdict = queueVerdict({ kind: 'unpause', output })
const say = { ok: 'success', note: 'info', warn: 'warn', fail: 'error' }[verdict.level]
for (const line of verdict.lines) log[say](`  ${line}`)

if (verdict.level === 'fail') {
  // Refused before the guard file is removed, so the app is still paused rather
  // than serving with its jobs held.
  log.error('The queues could not be resumed, so the edge was left paused')
  log.info('  fix what the bin refused, then run fli deploy:unpause again')
  context.config.abort = true
  throw new Error('the queue half of the unpause did not run')
}
```
