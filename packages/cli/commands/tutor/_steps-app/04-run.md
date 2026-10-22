---
title: 04-run
description: Start the two servers and prove they answer
---

## Running it

Two processes: the API on **{{apiPort}}** and the web app on **{{webPort}}**.
In a terminal of your own that is one command — `bun run dev` runs both — and
this lesson starts them separately so it can tell you which one did not come up.

The health check is at **/api/health** rather than `/health`, and that is worth
knowing now: `apiPrefix` in `api/config/junction.config.js` moves *every* route
the app registers, including the ones plugins add. One prefix, one place.

They are left running for the rest of the lesson. Their output goes to
`.tutor/api.log` and `.tutor/web.log` inside the app — a dev server writing over
this prose would make both unreadable, and a failed health check needs somewhere
to point.

```js
if (!await narrate($)) return

$.config.__step = 4

if (!needs($, ['appDir'], { from: '02-new' })) return

const api = await startServer($, {
  name:   'api',
  script: 'start',
  cwd:    $.config.appDir,
  env:    { FRONTIER_PORT_BE: String($.config.apiPort) },
  port:   $.config.apiPort,
  path:   '/api/health',
})

if (!await must($, api.up, {
  likely:    'the API exited on startup — the last of its output is below',
  reproduce: `cd ${$.config.appDir} && PORT=${$.config.apiPort} bun run start`,
  detail:    serverLog(api),
})) return

const web = await startWeb($)

if (!await must($, web.up, {
  likely:    'vite exited, or refused the port — it is strictPort, so it does not move',
  reproduce: `cd ${$.config.appDir} && WEB_PORT=${$.config.webPort} FRONTIER_PORT_BE=${$.config.apiPort} bun run web --host 127.0.0.1`,
  detail:    serverLog(web),
})) return

log.info('')
log.info(`  the app     http://127.0.0.1:${$.config.webPort}`)
log.info(`  the API     http://127.0.0.1:${$.config.apiPort}/api`)
log.info('')
```
