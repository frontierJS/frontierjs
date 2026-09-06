---
title: 08-finish
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
  if (app) log.info(`the app is still at ${app} — the notification and the wiring are where the lesson left them`)
  return
}

context.config.journal.settle('succeeded')

log.success('Lesson 7 done — one send, two transports, and a name that is data')
log.info('')
log.info(`  ${app}`)
log.info('')
log.info('  api/src/notifications/            one file per thing you have to say')
log.info('  api/src/core/outbox-mailer.ts     IMail is one method — point it at a provider')
log.info('  db/outbox.jsonl                   the mail this app sent, as lines')
log.info('')
log.info('  fli tutor:site                    next — a public site built ahead of time')
log.info('')

if (ws.kind === 'temp' && !context.flag.keep) {
  T.sweepWorkspace(ws, { keep: false })
  log.info('  (the temporary workspace was removed — pass --keep to hold on to it)')
}
```
