---
title: 09-finish
description: Stop the API, and say what was learnt
runOnAbort: true
---

```js
// Runs on the way out of a refusal too, so it reports and stops what it
// started rather than narrating over a diagnosis.

stopServers(context)

const ws  = context.config.ws
const app = context.config.appDir

if (context.config.abort) {
  if (app) log.info(`the app is still at ${app} — every schema edit this lesson made is in db/schema.lite`)
  return
}

context.config.journal.settle('succeeded')

log.success('Lesson 2 done — a gate that refuses, a policy that filters, a column that drops')
log.info('')
log.info(`  ${app}`)
log.info('')
log.info('  db/schema.lite            the four mechanisms, all in one file')
log.info('  db/access.snapshot.md     what they add up to, committed')
log.info('')
log.info('  fli tutor:deploy          next — a real deploy to this machine, and a revert')
log.info('')

if (ws.kind === 'temp' && !context.flag.keep) {
  T.sweepWorkspace(ws, { keep: false })
  log.info('  (the temporary workspace was removed — pass --keep to hold on to it)')
}
```
