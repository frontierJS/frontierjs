---
title: 02-run
description: Start the API — no browser in this lesson
---

## The API alone

Only the API is started. Every question in this lesson is asked with an HTTP
request, because the gate and the policies are enforced at the **Data boundary**
— under the service, under the route — so a browser would see exactly what
`curl` sees and would add a page to read in between.

```js
narrate(context)

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
