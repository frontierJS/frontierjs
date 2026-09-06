---
title: 06-finish
description: What was adopted, and what only you can add
runOnAbort: true
---

```js
context.config.prompts?.close()

const ws  = context.config.ws
const app = context.config.appDir

stopServers(context)

if (context.config.abort) {
  if (app) log.info(`the app is still at ${app} — imported.lite and gaps.json are in it`)
  return
}

context.config.journal.settle('succeeded')

log.success('Lesson 13 done — an existing database, read, checked, served, and its debt written down')
log.info('')
log.info(`  ${app}`)
log.info('')
log.info('  imported.lite             what the reading produced')
log.info('  gaps.json                 what it could not carry, graded')
log.info('  db/schema.lite            the same models, with the gates a database cannot hold')
log.info('  check-baseline.json       the debt you kept, and the number it may not pass')
log.info('')
log.info('  litestone import <file>   the other door — Prisma, Rails, a pg_dump')
log.info('  fli release:check         before the first schema change you deploy')
log.info('')
log.info('  That is the whole tutorial. Where to go from here:')
log.info('')
log.info('    example/                 the kitchen sink — five surfaces, a shop, a payroll,')
log.info('                             a payment provider, and a drive per feature area')
log.info('    fli gui                  the front page, beside whatever you are building')
log.info('    fli proves               which drive proves the change you just made')
log.info('    fli check                the architecture rules, run against your own app')
log.info('    ISSUES.md · DECISIONS.md · IDEAS/')
log.info('')

if (ws.kind === 'temp' && !context.flag.keep) {
  T.sweepWorkspace(ws, { keep: false })
  log.info('  (the temporary workspace was removed — pass --keep to hold on to it)')
}
```
