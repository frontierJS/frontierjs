---
title: 03-doors
description: Two ways to be somebody, and why they are not one
---

## `actingAs` and `atLevel`

There are two doors into a test's identity, and conflating them is the failure
this step exists to prevent.

```text
env.actingAs(session)   graded through the APP'S OWN getLevel
await env.atLevel(n)    graded by a synthetic resolver
```

`actingAs` is for **behavior**: it runs the resolver in `api/src/core/db.ts`, so
a broken resolver fails the test. `atLevel` is for walking the **grid** — it
builds a second client at a fixed level, which is the only way to ask *what does
level 3 see*, because a level is settled when a client is constructed and cannot
be a property of a call.

The trap is one-directional: a matrix driven entirely by `atLevel` passes **in
full while the app's own resolver is broken**, because the resolver was never
called.

**What `actingAs` takes is a session, not a row**, and that is the sharpest
thing here. The scaffolded resolver grades on `isAdmin`; the `User` table has a
`role` column. `sessionFields` in `api/src/core/auth.ts` is what turns one into
the other, and it runs when somebody signs in — not when a test hands a row
straight to `actingAs`. So `actingAs(adminRow)` grades **4**, not 5, and a test
asserting a refusal there passes for entirely the wrong reason. This step writes
both spellings and asserts they differ.

Every refusal below is paired with an otherwise identical call that is allowed.
A check that refused everybody would look exactly the same from the refused side.

```js
if (!await narrate(context)) return

context.config.__step = 3

if (!needs(context, ['appDir'], { from: '01-app' })) return

const app  = context.config.appDir
const file = join(app, 'api', 'test', 'doors.test.ts')

// The level Note READS at, taken from the schema rather than written down here.
// A literal would be right for a scaffolded app and wrong the moment a lesson
// raises the gate — which `tutor:access` does, three lessons on — and a test
// that has to be edited when the declaration moves is the thing this whole
// lesson is arguing against.
const gate = readFileSync(schemaFile(context), 'utf8')
  .match(/model Note \{[\s\S]*?@@gate\("(\d)/)
const readsAt = gate ? Number(gate[1]) : 0

// Below the level, where there is one. At STRANGER(0) there is nothing below,
// so the pair at the other end of the ladder — User, which reads at 4 — is what
// carries the refusal.
const belowNote = readsAt > 0
  ? [`  await expect((await env.atLevel(${readsAt - 1})).note.count()).rejects.toThrow()`]
  : []

writeFileSync(file, [
  "import { test, expect } from 'bun:test'",
  "import { createTestEnv } from '@frontierjs/litestone/testing'",
  '',
  'const open = () => createTestEnv({',
  "  schema:        'db/schema.lite',",
  '  encryptionKey: process.env.ENCRYPTION_KEY,',
  '  autoFactories: true,',
  '})',
  '',
  "test('a person may not delete a person, and an admin may', async () => {",
  '  const env = await open()',
  '',
  '  // Both are real User rows, written below the boundary. What separates the',
  '  // callers is one column, and the resolver in core/db.ts is what reads it',
  '  // — which is what makes this the door that grades that resolver.',
  "  const admin  = await env.factories.user.asSystem().createOne({ role: 'admin' })",
  "  const person = await env.factories.user.asSystem().createOne({ role: 'user' })",
  '',
  '  await expect(',
  '    env.actingAs(person).user.delete({ where: { id: admin.id } }),',
  '  ).rejects.toThrow()',
  '',
  '  // The ROW is not a session. getLevel reads isAdmin, which sessionFields',
  '  // projects at sign-in and nothing projects here, so the admin row alone',
  '  // still grades 4 and delete wants 5.',
  '  await expect(',
  '    env.actingAs(admin).user.delete({ where: { id: person.id } }),',
  '  ).rejects.toThrow()',
  '',
  '  // The pair. Same call, same rows, one projected claim.',
  '  const gone = await env.actingAs({ ...admin, isAdmin: true })',
  '    .user.delete({ where: { id: person.id } })',
  '  expect(gone).toBeDefined()',
  '',
  '  env.close()',
  '})',
  '',
  "test('the ladder is walked with atLevel, which calls no resolver', async () => {",
  '  const env = await open()',
  '',
  `  // Note reads at ${readsAt}, which is what db/schema.lite says today. No User`,
  '  // row exists for these callers and none is needed — that is the whole',
  '  // difference between the two doors.',
  "  await env.system.note.create({ data: { title: 'public', body: 'b', done: false } })",
  ...belowNote,
  `  expect(await (await env.atLevel(${readsAt})).note.count()).toBe(1)`,
  '',
  '  // And the other end of the same ladder: User reads at USER(4), so 3 is',
  '  // refused and 4 is the control that makes the refusal mean something.',
  '  await expect((await env.atLevel(3)).user.findMany()).rejects.toThrow()',
  '  expect(await (await env.atLevel(4)).user.findMany()).toBeDefined()',
  '',
  '  env.close()',
  '})',
  '',
].join('\n'), 'utf8')

if (!await must(context, probe.command({
  bin:      'bun',
  args:     ['test', 'api/test/doors.test.ts'],
  cwd:      app,
  needle:   /2 pass/,
  describe: 'both doors, each with its own control',
  name:     'a refusal, and the same call allowed',
}), {
  likely:    'the gate levels in this app differ from the scaffold — the tail is above',
  reproduce: `cd ${app} && bun test api/test/doors.test.ts`,
})) return

log.info('')
log.info('  actingAs   the app decides who this is — and it is handed a SESSION')
log.info('  atLevel    the grid, with no app in the way')
log.info(`  the level  read out of the schema — Note reads at ${readsAt} in this app`)
log.info('')

remember(context, '03-doors', { doorsFile: file })
```
