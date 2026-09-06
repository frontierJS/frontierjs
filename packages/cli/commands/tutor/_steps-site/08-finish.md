---
title: 08-finish
description: Stop the API, and say what was published
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
  if (app) log.info(`the app is still at ${app} — the site surface and its build are where the lesson left them`)
  return
}

context.config.journal.settle('succeeded')

log.success('Lesson 8 done — a public site built ahead of time, and a check that says what it published')
log.info('')
log.info(`  ${app}`)
log.info('')
log.info('  site/src/routes/notes/index.meta.js   load() — runs in Node, at build time')
log.info('  site/dist/notes/index.html            the page, with the data already in it')
log.info('')
log.info('  fli site:dev                          write against it as an SPA')
log.info('  fli tutor:deploy                      next — a real deploy to this machine, and a revert')
log.info('')

if (ws.kind === 'temp' && !context.flag.keep) {
  T.sweepWorkspace(ws, { keep: false })
  log.info('  (the temporary workspace was removed — pass --keep to hold on to it)')
}
```
