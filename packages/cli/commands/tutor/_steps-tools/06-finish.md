---
title: 06-finish
description: Stop the tools, and say when to open which
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
  if (app) log.info(`the app is still at ${app} — the tools were stopped, nothing else was undone`)
  return
}

context.config.journal.settle('succeeded')

log.success('Lesson 2 done — four tools, and a question each one answers')
log.info('')
log.info('  When to open which:')
log.info('')
log.info('    nothing is happening        fli gui           is it even running, and does it pass its checks')
log.info('    the screen is empty         fli db:studio     is the row there — and which file am I reading')
log.info('    the call did something odd  the console       what it answered, and the sentence it used')
log.info('    who handles this request    fli project:view  the chain, and the variables it needs')
log.info('')
log.info(`  ${app}`)
log.info('')

if (context.config.__devtoolsAdded) {
  log.info('  api/src/app.ts now configures devtools() — it is left in place on purpose.')
  log.info('  It binds to loopback and refuses to bind anywhere else without an auth')
  log.info('  gate, so it costs nothing to leave configured and is there when you need it.')
  log.info('')
}

log.info('  surface.snapshot.md       what this app answers — commit it; CI grades it')
log.info('')
log.info('  fli tutor:ui              next — the form nobody wrote, in a real browser')
log.info('')

if (ws.kind === 'temp' && !context.flag.keep) {
  T.sweepWorkspace(ws, { keep: false })
  log.info('  (the temporary workspace was removed — pass --keep to hold on to it)')
}
```
