---
title: 02-run
description: Start the API — no browser in this lesson
---

## The API alone

The API is started, and it is here only to put rows in the database — the site
build reads the SQLite file directly and needs no server at all, which is the
first thing worth noticing about it. A built page has nothing behind it.

```js
if (!await narrate($)) return

$.config.__step = 2

if (!needs($, ['appDir'], { from: '01-app' })) return

const api = await restartApi($)

if (!await must($, api.up, {
  likely:    'the API exited on startup — the last of its output is below',
  reproduce: `cd ${$.config.appDir} && PORT=${$.config.apiPort} bun run start`,
  detail:    serverLog(api),
})) return

log.info(`  the API     http://127.0.0.1:${$.config.apiPort}/api`)
```
