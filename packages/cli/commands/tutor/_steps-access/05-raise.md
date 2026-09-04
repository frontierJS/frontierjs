---
title: 05-raise
description: One character, and the same request answers differently
---

## Raising it

Change the first number from `0` to `4`:

```text
@@gate("4.4.4.6")
```

Push, restart, and ask the **same request** as the step before. It is now
refused. Nothing else changed — no service, no route, no hook.

The restart is not tidiness: an app reads `db/schema.lite` once, at
`createClient`, so a process started before the edit goes on enforcing the gate
it booted with.

```js
if (!await narrate(context)) return

context.config.__step = 5

if (!needs(context, ['appDir', 'userToken'], { from: { appDir: '01-app', userToken: '03-people' } })) return

const edit = editSchema(context, '@@gate("0.4.4.6")', '@@gate("4.4.4.6")')
if (!edit.ok) {
  log.error(`${edit.why} — this step edits the gate on model Note`)
  context.config.abort = true
  return
}

pushSchema(context)

const api = await restartApi(context)
if (!await must(context, api.up, {
  likely: 'the API did not come back after the schema change — its output is below',
  detail: serverLog(api),
})) return

if (!await must(context, probe.httpStatus({
  url:     apiUrl(context, '/notes'),
  expect:  401,
  retries: 5,
  name:    'the stranger who could list notes a moment ago is now refused',
}), {
  likely:    'the edit did not reach the running app — was db:push run, and did the API restart?',
  reproduce: `grep '@@gate' ${schemaFile(context)}`,
})) return

if (!await must(context, probe.httpStatus({
  url:     apiUrl(context, '/notes'),
  headers: asCaller(context.config.userToken),
  name:    'and a signed-in caller still reads them',
}), {
  likely: 'the read gate went above 4 — check the first of the four numbers',
})) return

log.info('one character in db/schema.lite, and the same GET answers 200 and 401')
```
