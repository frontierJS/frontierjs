---
title: 04-gate
description: The four numbers, as they already are
---

## `@@gate` — the four numbers

`model Note` carries one line of authorization:

```text
@@gate("0.4.4.6")
```

**read · create · update · delete**, each the lowest standing that may do it.
`0` is a stranger, `4` is a signed-in caller, `6` is the owner.

So a stranger may read notes and may not write one. Two requests prove it, and
both are needed: the refusal on its own would also be produced by a service that
refused everybody.

Nothing in `api/src/services/notes.service.ts` says any of this. The service is
eleven lines and none of them mention authentication.

```js
if (!await narrate(context)) return

context.config.__step = 4

if (!needs(context, ['appDir', 'userToken'], { from: { appDir: '01-app', userToken: '03-people' } })) return

if (!await refreshTokens(context)) return

if (!await must(context, await ensureApi(context), {
  likely: 'nothing is answering on the API port — run this lesson from the start',
})) return

const note = JSON.stringify({ title: 'a note', body: 'from lesson 2', done: false })

// read at 0 — a stranger, with no token at all
if (!await must(context, probe.httpStatus({
  url:  apiUrl(context, '/notes'),
  name: 'a stranger may LIST notes — read is 0',
}), {
  likely: 'the gate has been changed already, or the notes service did not load',
})) return

// create at 4 — the same stranger, refused
if (!await must(context, probe.httpStatus({
  url:     apiUrl(context, '/notes'),
  method:  'POST',
  headers: asCaller(null),
  body:    note,
  expect:  401,
  name:    'and may NOT write one — create is 4',
}), {
  likely:    'the create gate is not 4 — read the four numbers on model Note',
  reproduce: `grep -A 2 '@@gate' ${schemaFile(context)}`,
})) return

// …and the pair that makes the refusal mean something
if (!await must(context, probe.httpStatus({
  url:     apiUrl(context, '/notes'),
  method:  'POST',
  headers: asCaller(context.config.userToken),
  body:    note,
  expect:  201,
  name:    'a signed-in caller sending the same body is accepted',
}), {
  likely: 'the token from step 3 has expired, or the payload does not satisfy the model',
})) return
```
