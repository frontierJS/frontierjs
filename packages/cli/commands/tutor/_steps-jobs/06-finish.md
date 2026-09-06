---
title: 06-finish
description: Stop the API, and say what was built
runOnAbort: true
---

```js
// The reader `narrate` asks its questions through. Held open it keeps the event
// loop alive and the lesson never exits.
context.config.prompts?.close()

stopServers(context)

const ws  = context.config.ws
const app = context.config.appDir

if (context.config.abort) {
  if (app) log.info(`the app is still at ${app} — the job file and the wiring are where the lesson left them`)
  return
}

context.config.journal.settle('succeeded')

log.success('Lesson 6 done — a response that did not wait, and a row that says what happened')
log.info('')
log.info(`  ${app}`)
log.info('')
log.info('  api/src/jobs/finish-note.job.ts   the job — the file names it')
log.info('  db/jobs.db                        every piece of deferred work, as rows')
log.info('')
log.info('  fli tutor:notify                  next — telling somebody something')
log.info('')

if (ws.kind === 'temp' && !context.flag.keep) {
  T.sweepWorkspace(ws, { keep: false })
  log.info('  (the temporary workspace was removed — pass --keep to hold on to it)')
}
```
