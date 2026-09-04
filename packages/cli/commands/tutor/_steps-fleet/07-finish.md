---
title: 07-finish
description: Stop both processes, and say what was learnt
runOnAbort: true
---

```js
// The reader `narrate` asks its questions through. Held open it keeps the event
// loop alive and the lesson never exits.
context.config.prompts?.close()

// Runs on the way out of a refusal too, so it stops what it started rather than
// leaving a control plane and a machine listening after a diagnosis.

stopServers(context)

const ws = context.config.ws

if (context.config.stop) {
  context.config.journal.settle('succeeded')
  return
}

if (context.config.abort) {
  log.info(`  the control plane's database is at ${context.config.dbFile ?? join(ws.dir, 'basecamp.db')}`)
  log.info(`  both processes wrote to ${join(ws.dir, '.tutor')}`)
  return
}

context.config.journal.settle('succeeded')

log.success('Lesson 8 done — a machine that reported in, and a command that really ran on it')
log.info('')
log.info('  a Server row is the machine as a noun, and it starts at pending')
log.info('  the heartbeat is what moves it, and nothing you type can')
log.info('  reachable is a Conduit target, not a column — online and unreachable is a real state')
log.info('  every command is signed, and the machine verifies before it runs anything')
log.info('')
log.info('  This is the other release story. `fli deploy` is you, holding the key,')
log.info('  deploying one app to one machine. This is a control plane doing it for')
log.info('  a fleet, and the two share no code — the journal in lesson 3 lives on')
log.info('  the target, and a Deployment here is a row.')
log.info('')
log.info('  That is the whole tutorial. Where to go from here:')
log.info('')
log.info('    example/                 the kitchen sink — five surfaces, a shop, a payroll,')
log.info('                             a payment provider, and a drive per feature area')
log.info('    fli proves               which drive proves the change you just made')
log.info('    fli check                the architecture rules, run against your own app')
log.info('    ISSUES.md · DECISIONS.md · IDEAS/')
log.info('                             what is wrong, what is settled, what is not started')
log.info('')

if (ws.kind === 'temp' && !context.flag.keep) {
  T.sweepWorkspace(ws, { keep: false })
  log.info('  (the temporary workspace was removed — pass --keep to hold on to it)')
}
```
