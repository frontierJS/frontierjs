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

// Steps 6 and 7 are a PAIR — the anonymous socket hears it, and then does not —
// so this lesson has to start from the low gate. Lessons share a workspace and
// `tutor:access` raises the same line, so an app arriving here already changed
// is ordinary. Normalised rather than assumed: the alternative is a lesson
// whose headline depends on which lessons you ran before it.
const lowered = editSchema(context, '@@gate("4.4.4.6")', '@@gate("0.4.4.6")')
if (lowered.ok && !lowered.already) {
  log.info('  reads on Note were already gated — put back to 0, which is where this lesson starts')
  pushSchema(context)
}

const api = await restartApi(context)

if (!await must(context, api.up, {
  likely:    'the API exited on startup — the last of its output is below',
  reproduce: `cd ${context.config.appDir} && PORT=${context.config.apiPort} bun run start`,
  detail:    serverLog(api),
})) return

log.info(`  the API     http://127.0.0.1:${context.config.apiPort}/api`)
```
