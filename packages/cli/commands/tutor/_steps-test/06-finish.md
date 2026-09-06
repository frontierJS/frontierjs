---
title: 06-finish
description: Say what the checks answered, and what graded them
runOnAbort: true
---

```js
// The reader `narrate` asks its questions through. Held open it keeps the event
// loop alive and the lesson never exits.
context.config.prompts?.close()

const ws  = context.config.ws
const app = context.config.appDir

if (context.config.abort) {
  if (app) log.info(`the app is still at ${app} — the tests this lesson wrote are under api/test/`)
  return
}

context.config.journal.settle('succeeded')

log.success('Lesson 11 done — the schema executed, and something that grades the execution')
log.info('')
log.info(`  ${app}`)
log.info('')
log.info('  api/test/schema.test.ts   four checks nobody wrote')
log.info('  api/test/doors.test.ts    actingAs is handed a SESSION, never a row')
log.info('  bunx litestone mutate     what those checks cannot see')
log.info('')
log.info('  fli tutor:fleet           next — basecamp, and a machine that takes orders')
log.info('')

if (ws.kind === 'temp' && !context.flag.keep) {
  T.sweepWorkspace(ws, { keep: false })
  log.info('  (the temporary workspace was removed — pass --keep to hold on to it)')
}
```
