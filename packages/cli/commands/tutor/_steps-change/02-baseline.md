---
title: 02-baseline
description: What is serving now, written down
---

## The baseline

```console
fli release:check
```

With nothing to compare against, that writes `db/release.snapshot.md` — the
declared surface of this schema: every model, every column with its type and
default, the gates, the policies, the transitions. It is **committed**, and the
next run classifies the change against it.

The snapshot is not a migration and not a DDL dump. It is the half of a schema
another release can be hurt by, which is a smaller thing than the schema and a
different thing from the tables.

For the rest of this lesson the baseline is a **file** — `db/before.lite`, a
copy of the schema as it stands. In a real project it is a git ref
(`--from v1.4.0`, or `--from HEAD~1`), which is the same comparison with the
old version fetched rather than kept.

The copy lives beside the schema, and where it lives is worth one sentence: a
`.lite` file resolves its `import` lines against its own directory, so a
baseline kept somewhere else is asking about files that are not there. It is
read from the schema's directory when its own has no answer, and says so — but
a baseline that brought its own imports keeps them, because those are the ones
that release actually had.

```js
if (!await narrate(context)) return

context.config.__step = 2

if (!needs(context, ['appDir'], { from: '01-app' })) return

const app = context.config.appDir

context.exec({ command: `${context.fli} release:check`, cwd: app })

if (!await must(context, probe.fileExists({
  path: join(app, 'db', 'release.snapshot.md'),
  name: 'db/release.snapshot.md — the declared surface, committed',
}), {
  likely:    'release:check did not run — its output is above',
  reproduce: `cd ${app} && fli release:check`,
})) return

if (!await must(context, probe.fileContains({
  path:   join(app, 'db', 'release.snapshot.md'),
  needle: 'Note',
  name:   'and it knows about Note',
}), {
  likely: 'the snapshot was written from a different schema',
})) return

// Step 5 raises this gate and reads the verdict, so the baseline has to hold
// the LOW one. Lessons share a workspace and two of the others raise the same
// line, so an app arriving here already changed is ordinary — normalised rather
// than assumed, since the alternative is a lesson whose last step depends on
// which lessons you ran before it.
editSchema(context, '@@gate("4.4.4.6")', '@@gate("0.4.4.6")')

// The same normalisation for the column this lesson adds. Running it twice in
// one workspace would otherwise capture a baseline that ALREADY has `priority`,
// and step 3's expand would be graded `unchanged` — a lesson reporting that
// nothing happened because it had already happened.
//
// Written directly rather than through `editSchema`, whose contract is *the
// target wins where it is already there* — and every schema already contains
// the empty string, so a removal expressed that way is a no-op every time.
const before = readFileSync(schemaFile(context), 'utf8')
const without = before.replace(/^[ \t]*priority[ \t]+Int\??[ \t]*\r?\n/m, '')
if (without !== before) writeFileSync(schemaFile(context), without, 'utf8')

copyFileSync(schemaFile(context), join(app, 'db', 'before.lite'))

remember(context, '02-baseline', { baseline: 'db/before.lite' })
```
