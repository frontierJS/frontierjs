---
title: 02-first
description: A first test — a real database, in milliseconds
---

## The environment

A test needs a database. `createTestEnv` is one call and gives you a migrated
one, a client, factories and a principal:

```text
const env = await createTestEnv({
  schema:         'db/schema.lite',
  encryptionKey:  process.env.ENCRYPTION_KEY,
  autoFactories:  true,
})
```

Three things about it are worth knowing before you write the second one.

**The key is not optional here.** The schema declares `@encrypted` columns, so a
client with no key refuses to build — and the refusal is at `createTestEnv`,
naming the columns, rather than at whatever line you thought you were testing.

**The tables arrive as a file copy.** The DDL is applied once per schema per
process into a template; every environment after the first is a `copyFileSync`.
Migration cost is what dominates a real suite, and in SQLite a database per test
is a file copy — measured at 476ms → 13ms on a 37-model schema. So *one database
per test* is affordable, which is the thing that makes the rest of this lesson
possible.

**A factory writes through a real client, so it is graded.** `autoFactories`
derives one per model from the schema — nothing restates what a `Note` is — but
`Note` creates at USER(4) and a factory with no principal is a stranger, so the
setup is refused before the assertion is reached. `.asSystem()` is how a fixture
is written **below** the boundary, which is where a fixture belongs: a gate that
refuses the caller must not be able to refuse the arrangement.

The same is true of reading it back. `env.db` is a stranger, and *did the row
land* is a question about the arrangement rather than about the gate — so it is
asked through `env.system` too. A test that asks it as nobody passes today and
starts failing the day somebody raises the model's read gate, which is a change
that has nothing to do with the test.

```js
if (!await narrate(context)) return

context.config.__step = 2

if (!needs(context, ['appDir'], { from: '01-app' })) return

const app  = context.config.appDir
const dir  = join(app, 'api', 'test')
const file = join(dir, 'notes.test.ts')

mkdirSync(dir, { recursive: true })
writeFileSync(file, [
  "import { test, expect } from 'bun:test'",
  "import { createTestEnv } from '@frontierjs/litestone/testing'",
  '',
  "test('a note can be written and read back', async () => {",
  '  const env = await createTestEnv({',
  "    schema:        'db/schema.lite',",
  '    encryptionKey: process.env.ENCRYPTION_KEY,',
  '    autoFactories: true,',
  '  })',
  '',
  '  // Derived from the model — nothing here restates what a Note is, so a',
  '  // column added tomorrow arrives in this test for free. asSystem() because',
  '  // a factory writes through a real client and Note creates at USER(4).',
  "  const note = await env.factories.note.asSystem().createOne({ title: 'written by a test' })",
  '',
  '  expect(note.id).toBeDefined()',
  '  // Read back through env.system for the same reason the factory writes',
  '  // through it: a READ is graded too, and this line is checking the',
  '  // arrangement rather than exercising the gate. env.db is a stranger, and',
  '  // a stranger cannot read a model whose read gate an app has raised.',
  "  expect(await env.system.note.count({ where: { title: 'written by a test' } })).toBe(1)",
  '',
  '  env.close()',
  '})',
  '',
].join('\n'), 'utf8')

// `bun test` exits 0 when it finds no test files at all, so the assertion is on
// what it PRINTED. A step that checked the code alone would pass against a
// file the runner never saw — which is exactly what a wrong path looks like.
if (!await must(context, probe.command({
  bin:      'bun',
  args:     ['test', 'api/test/notes.test.ts'],
  cwd:      app,
  needle:   /1 pass/,
  describe: 'the test passes',
  name:     'a real database, written and read',
}), {
  likely:    'the test file did not compile, or the environment refused to build — the tail is above',
  reproduce: `cd ${app} && bun test api/test/notes.test.ts`,
})) return

log.info('')
log.info(`  ${file}`)
log.info('')

remember(context, '02-first', { testFile: file })
```
