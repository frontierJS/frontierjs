---
title: 10-finish
description: Stop the container, remove what was built, and say what happened
runOnAbort: true
---

```js
// The reader `narrate` asks its questions through. Held open it keeps the event
// loop alive and the lesson never exits.
context.config.prompts?.close()

// Runs on the way out of a refusal too. A lesson that left a container holding
// a port and eight images on the disk would be a lesson nobody runs twice.

const container = context.config.container

if (context.flag.keep) {
  log.info(`kept: the container ${container} is still running on :${context.config.port}`)
} else {
  dockerSweep(container, context.config.app)
}

const ws  = context.config.ws
const app = context.config.appDir

if (context.config.stop) {
  // Step 1 decided this machine is not a deploy target. Nothing was built.
  return
}

if (context.config.abort) {
  if (app) log.info(`the app is still at ${app}`)
  log.info('the container and the images this lesson built have been removed')
  return
}

context.config.journal.settle('succeeded')

log.success('Lesson 6 done — deployed, redeployed, reverted, and reverted back')
log.info('')
log.info(`  ${app}`)
log.info('')
log.info('  frontier.config.js        the machine, the directory, the port')
log.info('  db/release.snapshot.md    what a release IS, so a pivot can be classified')
log.info('  fli deploy:journal        what the machine remembers')
log.info('')
log.info('  Deploying to a real host is the same commands with a real hostname in')
log.info('  frontier.config.js, and `fli deploy:setup` to prepare the machine.')
log.info('')
log.info('  fli tutor:change          next — changing the schema of something already deployed')
log.info('')

if (ws.kind === 'temp' && !context.flag.keep) {
  T.sweepWorkspace(ws, { keep: false })
  log.info('  (the temporary workspace was removed — pass --keep to hold on to it)')
}
```
