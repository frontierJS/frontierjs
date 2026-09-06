---
title: 09-finish
description: Stop the API, and say what was learnt
runOnAbort: true
---

```js
// The reader `narrate` asks its questions through. Held open it keeps the event
// loop alive and the lesson never exits.
context.config.prompts?.close()

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

log.success('Lesson 4 done — a gate that refuses, a policy that filters, a column that drops')
log.info('')
log.info(`  ${app}`)
log.info('')
log.info('  db/schema.lite            the four mechanisms, all in one file')
log.info('  db/access.snapshot.md     what they add up to, committed')
log.info('')
log.info('  fli tutor:live            next — a change reaching a second client, and who it does not')
log.info('')

if (ws.kind === 'temp' && !context.flag.keep) {
  T.sweepWorkspace(ws, { keep: false })
  log.info('  (the temporary workspace was removed — pass --keep to hold on to it)')
}
```
