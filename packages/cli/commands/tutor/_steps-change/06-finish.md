---
title: 06-finish
description: Say what the three verdicts were
runOnAbort: true
---

```js
// The reader `narrate` asks its questions through. Held open it keeps the event
// loop alive and the lesson never exits.
context.config.prompts?.close()

const ws  = context.config.ws
const app = context.config.appDir

if (context.config.abort) {
  if (app) log.info(`the app is still at ${app} — db/before.lite is the baseline this lesson compared against`)
  return
}

context.config.journal.settle('succeeded')

log.success('Lesson 10 done — expand, contract, and a change that touched no column')
log.info('')
log.info(`  ${app}`)
log.info('')
log.info('  db/release.snapshot.md    the declared surface — commit it')
log.info('  fli release:check --from <ref> --strict')
log.info('                            the gate a branch that deploys puts in CI')
log.info('')
log.info('  fli tutor:test            next — the checks a schema already knows how to run')
log.info('')

if (ws.kind === 'temp' && !context.flag.keep) {
  T.sweepWorkspace(ws, { keep: false })
  log.info('  (the temporary workspace was removed — pass --keep to hold on to it)')
}
```
