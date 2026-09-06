---
title: 07-ask
description: What can this app send? Asked, with nothing sent
---

## Asking without sending

A preferences screen has to list what a person can turn off, and a devtools
panel has to list what an app can send. Both need the same answer and neither
should have to send anything to get it.

`via` takes the payload rather than closing over it, which is what makes the
answer free. Every definition the loader found is on the app:

```text
app.get('/notification-types', (ctx) => ctx.json([...(app.notifications?.keys() ?? [])]))
```

`app.notifications` is a **claim** — `app.claim('notifications', registry)` — and
one owner claims each `app.<thing>` exactly once. It is a read-only map on
purpose: a type added at runtime is a type the build cannot see, and the browser
reads this column to pick a renderer.

The answer here is `["NoteAdded"]` — the name step 5 held still, not the file it
now lives in. What the app can send is the type, and the file is where it is
written.

```js
if (!await narrate(context)) return

context.config.__step = 7

if (!needs(context, ['appDir'], { from: '01-app' })) return

const app   = context.config.appDir
const appTs = join(app, 'api', 'src', 'app.ts')

let src = readFileSync(appTs, 'utf8')
if (!src.includes('/notification-types')) {
  const ANCHOR = "  transports: { email: { mailer: 'default' } },\n}))"
  if (!src.includes(ANCHOR)) {
    await must(context, {
      ok:    false,
      name:  'api/src/app.ts has the place this step edits',
      asked: "the plugin block step 3 wrote",
      got:   'a file that has been changed under the lesson',
    }, {
      likely:    'add the route by hand — the prose above is the whole of it',
      reproduce: `grep -n notificationsPlugin ${appTs}`,
    })
    return
  }
  src = src.replace(ANCHOR, [
    ANCHOR,
    '',
    '// What this app can send, asked with nothing sent. `via` takes its payload',
    '// rather than closing over one, which is what makes the answer free.',
    "app.get('/notification-types', (ctx) => ctx.json([...(app.notifications?.keys() ?? [])]))",
  ].join('\n'))
  writeFileSync(appTs, src, 'utf8')
}

const api = await restartApi(context)
if (!await must(context, api.up, {
  likely: 'the API did not come back — the last of its output is below',
  detail: serverLog(api),
})) return

if (!await must(context, probe.httpJson({
  url:      apiUrl(context, '/notification-types'),
  expect:   (j) => Array.isArray(j) && j.length === 1 && j[0] === 'NoteAdded',
  describe: 'the one type this app declares, by the name it states',
  name:     'the app can say what it is able to send',
}), {
  likely:    'the loader found no definitions — it probes notifications/ and src/notifications/ beside the ENTRY, so an app started from elsewhere finds none',
  detail:    serverLog(api),
  reproduce: `curl -s http://127.0.0.1:${context.config.apiPort}/api/notification-types`,
})) return
```
