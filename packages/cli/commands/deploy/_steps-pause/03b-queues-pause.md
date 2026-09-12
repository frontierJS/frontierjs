---
title: 03b-queues-pause
description: Drain every queue in the serving container, once the edge is refusing
skip: "context.config.pauseKind !== 'pause'"
---

```js
if (context.config.abort) return

const { host, serverPath, appId, deployConf, transitionId } = context.config
const { queueScript, queueVerdict } = await import(new URL('file://' + global.fliRoot + '/core/pause.js'))

// After the edge, not before (FJS-D262): callers stop first, then the work they
// left behind is drained. A dispatch that lands in between is queued, not run.
log.info('Draining every queue in the running app...')
const output = machineFor(context, host, serverPath).capture(queueScript({
  container: apiContainer(appId, deployConf),
  verb:      'drain',
  actor:     context.git.user?.() ?? null,
  reason:    `fli deploy:pause ${transitionId}`,
}))

const verdict = queueVerdict({ kind: 'pause', output })
const say = { ok: 'success', note: 'info', warn: 'warn', fail: 'error' }[verdict.level]
for (const line of verdict.lines) log[say](`  ${line}`)

if (verdict.level === 'fail') {
  // The edge stays paused. More paused is the safe direction, and running the
  // pause again is accepted over a guard file the journal did not record.
  log.error('The edge is paused and the queues are NOT — jobs are still running')
  log.info('  fix what the bin refused, then run fli deploy:pause again')
  context.config.abort = true
  throw new Error('the queue half of the pause did not run')
}
```
