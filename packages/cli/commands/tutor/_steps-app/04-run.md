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
if (!await narrate(context)) return

context.config.__step = 4

if (!needs(context, ['appDir'], { from: '02-new' })) return

const api = await startServer(context, {
  name:   'api',
  script: 'start',
  cwd:    context.config.appDir,
  env:    { PORT: String(context.config.apiPort) },
  port:   context.config.apiPort,
  path:   '/api/health',
})

if (!await must(context, api.up, {
  likely:    'the API exited on startup — the last of its output is below',
  reproduce: `cd ${context.config.appDir} && PORT=${context.config.apiPort} bun run start`,
  detail:    serverLog(api),
})) return

// The web server proxies to the API, so it is told where that is. Without
// FLI_PORT_BE it proxies to 8100 whatever --api-port said, and the browser gets
// a 502 from a page that loaded perfectly.
const web = await startServer(context, {
  name:   'web',
  script: 'dev:web',
  cwd:    context.config.appDir,
  env:    { WEB_PORT: String(context.config.webPort), FLI_PORT_BE: String(context.config.apiPort) },
  port:   context.config.webPort,
  path:   '/',
})

if (!await must(context, web.up, {
  likely:    'vite exited, or refused the port — it is strictPort, so it does not move',
  reproduce: `cd ${context.config.appDir} && WEB_PORT=${context.config.webPort} bun run dev:web`,
  detail:    serverLog(web),
})) return

log.info('')
log.info(`  the app     http://127.0.0.1:${context.config.webPort}`)
log.info(`  the API     http://127.0.0.1:${context.config.apiPort}/api`)
log.info('')
```
