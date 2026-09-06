---
title: 06-finish
description: Stop the servers and the browser, and say what was not written
runOnAbort: true
---

```js
context.config.prompts?.close()

stopServers(context)

const ws  = context.config.ws
const app = context.config.appDir

if (context.config.abort) {
  if (app) log.info(`the app is still at ${app} — the servers and the browser were stopped`)
  return
}

// `stop` is the no-Chrome exit: nothing failed and nothing ran.
if (context.config.stop) return

context.config.journal.settle('succeeded')

log.success('Lesson 3 done — a form nobody wrote, refusing on a rule nobody wired')
log.info('')
log.info('  What was never written down twice:')
log.info('')
log.info('    the field list          <Form> reads the writable columns off the schema')
log.info('    the control per type    one table — a String is a box, a Boolean is a checkbox')
log.info('    the rules               @length reached the input as minlength/maxlength')
log.info('    the label               derived from the column, or @label when you want another')
log.info('')
log.info(`  ${app}`)
log.info('')
log.info('  web/src/resources/Note.mesa   the noun — the data half, and the default form')
log.info('  web/src/routes/notes/         three pages, each one tag and a heading')
log.info('')
log.info('  Children win: <Form> generates only when you pass none, so a page that')
log.info('  wants a different form writes one and keeps everything else.')
log.info('')
log.info('  fli tutor:access          next — the gate and the row policy, watched refusing somebody')
log.info('')

if (ws.kind === 'temp' && !context.flag.keep) {
  T.sweepWorkspace(ws, { keep: false })
  log.info('  (the temporary workspace was removed — pass --keep to hold on to it)')
}
```
