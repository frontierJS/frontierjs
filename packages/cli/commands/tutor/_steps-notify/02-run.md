---
title: 02-run
description: Start the API — there is no screen in this lesson
---

## The API alone

Only the API is started. Everything this lesson asserts is on the server side of
a notification: the row it writes, the mail it renders, and what it refuses. A
bell menu is a screen you already know how to build — `tutor:ui` builds one —
and putting one here would test the screen instead of the send.

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
