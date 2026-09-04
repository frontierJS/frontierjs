---
title: 03-rows
description: Three notes, so the build has something to bake
---

## Something to publish

Three rows, written the ordinary way. The site build reads them from the
database file rather than over HTTP, but they have to be there first, and going
through the API means they are written the same way everything else in this app
writes.

```js
if (!await narrate(context)) return

context.config.__step = 3

if (!needs(context, ['appDir'], { from: '01-app' })) return

if (!await must(context, await ensureApi(context), {
  likely: 'nothing is answering on the API port — run this lesson from the start',
})) return

const run        = Date.now().toString(36)
const registered = await registerAccount(context, {
  email:    `site-${run}@example.test`,
  password: 'correct-horse-battery-staple',
  name:     'Ada',
})
if (!await must(context, registered, { likely: 'auth is not installed in this app' })) return
context.config.userToken = registered.json.token

const titles = ['Feed the cat', 'Ship the site', 'Read the seed'].map(t => `${t} (${run})`)

for (const title of titles) {
  const made = await createNote(context, title)
  if (!await must(context, made, { likely: 'the write was refused — the body is above' })) return
}

if (!await must(context, probe.sqliteRow({
  db:     join(context.config.appDir, 'db', 'app.db'),
  sql:    'select count(*) as n from note',
  expect: (rows) => Number(rows[0]?.n) >= 3,
  name:   'three notes are in db/app.db',
}), {
  likely: 'the writes were accepted and did not land — which is the shape a soft delete leaves',
})) return

remember(context, '03-rows', { titles })
```
