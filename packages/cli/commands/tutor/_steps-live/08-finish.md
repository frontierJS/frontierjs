---
title: 08-finish
description: Stop the API, and say what was watched
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
  if (app) log.info(`the app is still at ${app} — the gate this lesson raised is in db/schema.lite`)
  return
}

context.config.journal.settle('succeeded')

log.success('Lesson 5 done — a publish that reaches one client and not the other')
log.info('')
log.info(`  ${app}`)
log.info('')
log.info('  api/src/services/notes.service.ts   channel: the name a publish goes out on')
log.info('  db/schema.lite                      the rule that decides who receives it')
log.info('')
log.info('  fli tutor:jobs                      next — work that outlives the request')
log.info('')

if (ws.kind === 'temp' && !context.flag.keep) {
  T.sweepWorkspace(ws, { keep: false })
  log.info('  (the temporary workspace was removed — pass --keep to hold on to it)')
}
```
