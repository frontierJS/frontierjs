---
title: 10-finish
description: Stop the servers, and say what you have
runOnAbort: true
---

```js
// No narration: this step runs on the way out of a REFUSAL as well as at the
// end, and a page of prose after a failed step buries the diagnosis that
// matters. It reports, and stops what it started.

stopServers(context)

const ws  = context.config.ws
const app = context.config.appDir

if (context.config.abort) {
  if (app) log.info(`the app is still at ${app} — nothing was undone`)
  // Not `settle`: the lesson did not finish, and the row for the step that
  // refused already says so. Marking the lesson `failed` here would lose the
  // resume, which is the whole reason the journal exists.
  return
}

context.config.journal.settle('succeeded')

log.success('Lesson 1 done — an app that runs, with a model of your own in it')
log.info('')
log.info(`  ${app}`)
log.info('')
log.info('  bun run dev        both servers again')
log.info('  db/schema.lite     the source everything else is derived from')
log.info('')
log.info('  fli tutor:access   next — the gate and the row policy, watched refusing somebody')
log.info('')

// A named workspace is the person's and is never swept. A temporary one is
// swept unless they asked to keep it — and the path is printed either way,
// because a lesson that silently deleted the app it just taught you to build
// is a lesson you cannot go back to.
if (ws.kind === 'temp' && !context.flag.keep) {
  T.sweepWorkspace(ws, { keep: false })
  log.info('  (the temporary workspace was removed — pass --keep to hold on to it)')
}
```
