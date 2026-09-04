---
title: 06-policy
description: A row policy — a 200 with fewer rows in it
---

## `@@allow` — which rows

A gate is about the **caller**. It cannot say *your own notes*, because that is
a fact about the row. That is `@@allow`, and it behaves differently on purpose:

**a gate refuses, a policy filters.** A wrong policy is not an error — it is an
empty screen with a 200. Read one as *which rows*, never as *which callers*.

Two lines are added. The first is not a policy at all:

```text
@@auth
```

on `model User`, which names the model a caller IS. Without it litestone cannot
check a claim name, and a misspelling compiles to NULL — read as *nobody* by the
SQL half and *everybody* by the JS half, so one typo is a lockout on read and an
open door on create. The app prints a warning about this at every boot until it
is there.

Then, on `model Note`:

```text
authorId  String?  @default(auth().id)

@@allow('read', authorId == auth().id)
```

The column stamps itself with whoever created the row. The policy compiles into
the WHERE clause of every read. Two accounts, one list endpoint, two different
answers — both 200.

```js
if (!await narrate(context)) return

context.config.__step = 6

if (!needs(context, ['appDir', 'userToken', 'adminToken'], { from: { appDir: '01-app', userToken: '03-people' } })) return

if (!await refreshTokens(context)) return

for (const [from, to] of [
  ['  @@gate("4.4.4.5")', '  @@auth\n  @@gate("4.4.4.5")'],
  ['  updatedAt DateTime  @default(now()) @updatedAt\n\n  ///',
   '  updatedAt DateTime  @default(now()) @updatedAt\n  authorId  String?   @default(auth().id)\n\n  @@allow(\'read\', authorId == auth().id)\n\n  ///'],
]) {
  const edit = editSchema(context, from, to)
  if (!edit.ok) {
    log.error(`${edit.why} — this step adds @@auth to User and a read policy to Note`)
    context.config.abort = true
    return
  }
}

pushSchema(context)

const api = await restartApi(context)
if (!await must(context, api.up, { likely: 'the API did not come back', detail: serverLog(api) })) return

// A note owned by the ordinary caller. Nothing states the author — the column's
// own default does.
const mine = await probe.httpJson({
  url:      apiUrl(context, '/notes'),
  method:   'POST',
  headers:  asCaller(context.config.userToken),
  body:     JSON.stringify({ title: `owned ${Date.now().toString(36)}`, body: 'mine', done: false }),
  expect:   (j) => typeof j.authorId === 'string' && j.authorId.length > 0,
  describe: 'a note stamped with its author',
  name:     'the note records who wrote it, without being told',
})
if (!await must(context, mine, {
  likely: '@default(auth().id) did not stamp — is @@auth on model User?',
})) return

const countFor = (token, name) => probe.httpJson({
  url:      apiUrl(context, '/notes'),
  headers:  asCaller(token),
  expect:   (j) => true,
  describe: 'the list',
  name,
})

const asOwner = await countFor(context.config.userToken, 'the author lists their note')
if (!await must(context, asOwner, { likely: 'the list did not answer' })) return

const asOther = await countFor(context.config.adminToken, 'the other account lists the same endpoint')
if (!await must(context, asOther, { likely: 'the list did not answer' })) return

const ownerSees = asOwner.json.data.filter(n => n.id === mine.json.id).length
const otherSees = asOther.json.data.filter(n => n.id === mine.json.id).length

if (!await must(context, {
  ok:    ownerSees === 1 && otherSees === 0,
  name:  'the same GET answers 200 to both, and one of them cannot see the row',
  asked: 'the author sees their note and the other account does not',
  got:   `author saw it ${ownerSees} time(s), the other account ${otherSees}`,
}, {
  likely:    otherSees > 0
    ? 'the policy is not filtering — check @@allow on model Note and @@auth on model User'
    : 'the author cannot see their own row either, which is a policy that refuses everybody',
  reproduce: `grep -n "@@allow" ${schemaFile(context)}`,
})) return

remember(context, '06-policy', { policiedNoteId: mine.json.id })
```
