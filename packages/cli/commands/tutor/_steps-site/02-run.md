---
title: 02-run
description: Start the API — no browser in this lesson
---

## The API alone

The API is started, and it is here only to put rows in the database — the site
build reads the SQLite file directly and needs no server at all, which is the
first thing worth noticing about it. A built page has nothing behind it.

```js
if (!await narrate(context)) return

context.config.__step = 2

if (!needs(context, ['appDir'], { from: '01-app' })) return

const api = await restartApi(context)

if (!await must(context, api.up, {
  likely:    'the API exited on startup — the last of its output is below',
  reproduce: `cd ${context.config.appDir} && PORT=${context.config.apiPort} bun run start`,
  detail:    serverLog(api),
})) return

log.info(`  the API     http://127.0.0.1:${context.config.apiPort}/api`)
```
