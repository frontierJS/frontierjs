---
title: 08-write
description: Write a row, and read it back out of the file
---

## A row

Two requests, identical but for one header.

The one **with** the token is accepted. The one **without** it is refused with a
401, by a rule you have not written — `@@gate("0.4.4.6")` says writes need a
signed-in caller, and that is the only place it is said.

A refusal on its own proves nothing: a service that refused everything would
look exactly the same from the refused side. So the pair is asked together, and
the accepted one is then checked **in the database file** rather than in the
response — a 201 says the request was answered, and only the row says the write
happened.

```js
narrate(context)

context.config.__step = 8

if (!needs(context, ['appDir', 'token'], { from: { appDir: '02-new', token: '05-register' } })) return

if (!await must(context, await ensureApi(context), {
  likely:    'nothing is answering on the API port — run the lesson from the start, or `bun run dev` in the app',
  reproduce: `cd ${context.config.appDir} && PORT=${context.config.apiPort} bun run start`,
})) return

const title = `First note ${Date.now().toString(36)}`
const body  = JSON.stringify({ title, body: 'Written by the tutor.', done: false })

const created = await probe.httpJson({
  url:     apiUrl(context, '/notes'),
  method:  'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${context.config.token}` },
  body,
  expect:   (j) => j && j.title === title,
  describe: 'the created note',
  name:     'POST /api/notes with a token is accepted',
})

if (!await must(context, created, {
  likely:    'the token has expired, or the service refused the payload — the body is above',
  reproduce: `curl -sS -X POST ${apiUrl(context, '/notes')} -H 'authorization: Bearer …' -H 'content-type: application/json' -d '${body}'`,
})) return

// The control. Same URL, same payload, no token — and it must be refused, or
// the acceptance above says nothing about the gate.
if (!await must(context, probe.httpStatus({
  url:     apiUrl(context, '/notes'),
  method:  'POST',
  headers: { 'content-type': 'application/json' },
  body,
  expect:  401,
  name:    'the same POST with no token is refused',
}), {
  likely:    'the gate on Note was changed, or the service overrides create',
  reproduce: `curl -sS -i -X POST ${apiUrl(context, '/notes')} -H 'content-type: application/json' -d '${body}'`,
})) return

if (!await must(context, probe.sqliteRow({
  db:     join(context.config.appDir, 'db', 'app.db'),
  sql:    'select id, title from note where title = ?',
  params: [title],
  expect: (rows) => rows.length === 1,
  name:   'the row is in db/app.db',
}), {
  likely: 'the API is writing to a different database than the one this is reading — check DATABASE_URL in .env',
})) return

log.info(`open http://127.0.0.1:${context.config.webPort}/notes/ and it is there`)
remember(context, '08-write', { noteId: created.json.id })
```
