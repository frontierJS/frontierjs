---
title: 02-run
description: Start the API — no browser in this lesson
---

## The API alone

Only the API is started. Nothing in this lesson is on a screen: what is being
asserted is that a response came back before the work was done, and the row a
separate process wrote afterwards. A browser could show neither.

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
