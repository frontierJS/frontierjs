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
if (!await narrate($)) return

$.config.__step = 3

if (!needs($, ['appDir'], { from: '01-app' })) return

if (!await must($, await ensureApi($), {
  likely: 'nothing is answering on the API port — run this lesson from the start',
})) return

const run        = Date.now().toString(36)
const registered = await registerAccount($, {
  email:    `site-${run}@example.test`,
  password: 'correct-horse-battery-staple',
  name:     'Ada',
})
if (!await must($, registered, { likely: 'auth is not installed in this app' })) return
$.config.userToken = registered.json.token

const titles = ['Feed the cat', 'Ship the site', 'Read the seed'].map(t => `${t} (${run})`)

for (const title of titles) {
  const made = await createNote($, title)
  if (!await must($, made, { likely: 'the write was refused — the body is above' })) return
}

if (!await must($, probe.sqliteRow({
  db:     join($.config.appDir, 'db', 'app.db'),
  sql:    'select count(*) as n from note',
  expect: (rows) => Number(rows[0]?.n) >= 3,
  name:   'three notes are in db/app.db',
}), {
  likely: 'the writes were accepted and did not land — which is the shape a soft delete leaves',
})) return

remember($, '03-rows', { titles })
```
