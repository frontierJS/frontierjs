---
title: 02-run
description: Start the API — no browser in this lesson
---

## The API alone

Only the API is started. Every client in this lesson is a socket opened against
it directly, so there is no page in between — and no page is the point: what is
being asserted is which connections a broadcast reaches, and a browser can only
ever be one of them, signed in.

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
