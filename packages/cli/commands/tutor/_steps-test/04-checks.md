---
title: 04-checks
description: Four checks nobody wrote — the schema, executed
---

## The checks the schema already contains

Four calls, no fixtures, no assertions to author:

```text
await env.verifyGateLadder()        every declared level, R C U D, per gated model
await env.verifyFieldProtection()   every @guarded / @encrypted / @secret column, read back
await env.verifyConstraints()       every validator, with values either side of its boundary
await env.verifyRowPolicies()       every @@allow / @@deny, against rows on both sides
```

Each answers **an array of rows that are already sentences**, so a passing suite
is `toEqual([])` and a failing one tells you what disagreed:

```text
Server.read at level 1 (VISITOR) — the schema says deny, the client says allow
```

They are four separate boundaries and a model can pass one while failing
another. The ladder says who may read the **row**; field protection says which
**columns** come back when they do — an `@guarded` secret under a gate that
admits ADMINISTRATOR(5) has nothing but the field policy between an admin and a
private key.

Two details in there are worth more than the four calls.

**A throw that is not a refusal is a mismatch, never a pass.** An `@@external`
model emits no DDL, so its reads fail with *no such table* at every level — and
a ladder counting every throw as a refusal would call that green everywhere the
gate refuses.

**`verifyConstraints` runs as system on purpose.** The question is whether the
validator is enforced, and a `@@gate` refusing the write first would answer
*rejected* for every case, including the ones nothing validates.

What none of it proves is itself. That is the next step.

```js
if (!await narrate(context)) return

context.config.__step = 4

if (!needs(context, ['appDir'], { from: '01-app' })) return

const app  = context.config.appDir
const file = join(app, 'api', 'test', 'schema.test.ts')

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
  '// Four boundaries, four tests. Separate rather than one, because a suite',
  '// that reports "the schema is wrong" has told you nothing about which of',
  '// the four to open.',
  "test('every gate is enforced at every declared level', async () => {",
  '  const env = await open()',
  '  expect(await env.verifyGateLadder()).toEqual([])',
  '  env.close()',
  '})',
  '',
  "test('every protected column is protected', async () => {",
  '  const env = await open()',
  '  expect(await env.verifyFieldProtection()).toEqual([])',
  '  env.close()',
  '})',
  '',
  "test('every declared constraint is refused when violated', async () => {",
  '  const env = await open()',
  '  expect(await env.verifyConstraints()).toEqual([])',
  '  env.close()',
  '})',
  '',
  "test('every row policy filters the way it reads', async () => {",
  '  const env = await open()',
  '  expect(await env.verifyRowPolicies()).toEqual([])',
  '  env.close()',
  '})',
  '',
].join('\n'), 'utf8')

if (!await must(context, probe.command({
  bin:      'bun',
  args:     ['test', 'api/test/schema.test.ts'],
  cwd:      app,
  needle:   /4 pass/,
  describe: 'four executed checks, all clean',
  name:     'the schema, run against itself',
}), {
  likely:    'one of the four found something — its rows are sentences, in the tail above',
  reproduce: `cd ${app} && bun test api/test/schema.test.ts`,
})) return

log.info('')
log.info('  none of those four is a test anybody wrote')
log.info('')

remember(context, '04-checks', { checksFile: file })
```
