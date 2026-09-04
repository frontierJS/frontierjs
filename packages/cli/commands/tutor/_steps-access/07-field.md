---
title: 07-field
description: A column one caller may write and another may not — and the refusal is silent
---

## `@allow('write', …)` — which columns

The third mechanism is per **column**, and it does a third thing. A gate
refuses, a policy filters, and a field policy **drops**:

```text
done  Boolean  @default(false)  @allow('write', auth().isAdmin)
```

Both callers now send the identical body, `done: true`. Both are answered
**201**. One of the two rows comes back with `done: false`, because the column
was not theirs to write and the value was dropped on the way in.

That silence is deliberate. The same form body is legitimate one standing up, so
refusing the whole request would fail a create that is otherwise entirely
correct — the policy takes the column and keeps the row.

The `@default(false)` matters more than it looks. Without it the column is
required and unwritable by the ordinary caller at once, and the write fails at
the database rather than at the boundary.

```js
narrate(context)

context.config.__step = 7

if (!needs(context, ['appDir', 'userToken', 'adminToken'], { from: { appDir: '01-app', userToken: '03-people' } })) return

if (!await refreshTokens(context)) return

const edit = editSchema(context,
  '  done      Boolean',
  "  done      Boolean   @default(false) @allow('write', auth().isAdmin)")

if (!edit.ok) {
  log.error(`${edit.why} — this step puts a write policy on Note.done`)
  context.config.abort = true
  return
}

pushSchema(context)

const api = await restartApi(context)
if (!await must(context, api.up, { likely: 'the API did not come back', detail: serverLog(api) })) return

const body = JSON.stringify({ title: `flag ${Date.now().toString(36)}`, body: 'same body, two callers', done: true })

const byUser = await probe.httpJson({
  url:      apiUrl(context, '/notes'),
  method:   'POST',
  headers:  asCaller(context.config.userToken),
  body,
  expect:   (j) => typeof j.done === 'boolean',
  describe: 'a created note',
  name:     'the ordinary caller sends done: true and is accepted',
})
if (!await must(context, byUser, {
  likely: 'the create was refused outright — a field policy drops the column, it does not refuse the row',
})) return

const byAdmin = await probe.httpJson({
  url:      apiUrl(context, '/notes'),
  method:   'POST',
  headers:  asCaller(context.config.adminToken),
  body,
  expect:   (j) => typeof j.done === 'boolean',
  describe: 'a created note',
  name:     'the administrator sends the identical body and is accepted',
})
if (!await must(context, byAdmin, { likely: 'the admin create was refused' })) return

if (!await must(context, {
  ok:    byUser.json.done === false && byAdmin.json.done === true,
  name:  'and only one of the two rows carries the value that was sent',
  asked: 'done stored false for the ordinary caller and true for the administrator',
  got:   `ordinary caller stored ${byUser.json.done}, administrator stored ${byAdmin.json.done}`,
}, {
  likely: byUser.json.done === true
    ? 'the column is writable by anyone — is the @allow on `done`, and is isAdmin really true for the admin?'
    : 'neither caller could write it, which is a rule that refuses everybody',
  reproduce: `grep -n "done" ${schemaFile(context)}`,
})) return
```
