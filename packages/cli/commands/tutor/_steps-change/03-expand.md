---
title: 03-expand
description: A column you can take back
---

## Expand

One optional column:

```text
priority  Int?
```

The release still serving does not know it exists, and does not have to: it
writes rows without it and the database fills in nothing. Roll the new release
off and the old one keeps working, with the column sitting there unread.

```console
fli release:check --from db/before.lite --strict
```

**expand**. `--strict` is the gate a branch puts in CI — it exits non-zero on
anything that is not expand or unchanged, so a change that cannot be undone
cannot arrive unnoticed.

```js
if (!await narrate(context)) return

context.config.__step = 3

if (!needs(context, ['appDir', 'baseline'], { from: '02-baseline' })) return

const app  = context.config.appDir
const edit = addNoteField(context, '  priority  Int?')

if (!await must(context, {
  ok:    edit.ok,
  name:  'Note gains an optional priority',
  asked: 'the column added to the model',
  got:   edit.ok ? (edit.already ? 'it was already there' : 'it was added') : edit.why,
}, {
  likely: 'the seed has no `model Note {` block to add to',
})) return

const r = fliJson(context, ['release:check', '--from', 'db/before.lite', '--json'], app)

if (!await must(context, {
  ok:    r.json?.verdict === 'expand',
  name:  'the verdict is expand — this deploy can be taken back',
  asked: 'verdict: expand',
  got:   r.json ? `verdict: ${r.json.verdict}` : `no JSON — ${(r.stderr || r.stdout).slice(0, 200)}`,
}, {
  likely:    'the column was added as required, which is the next step rather than this one',
  reproduce: `cd ${app} && fli release:check --from db/before.lite`,
})) return

// The gate a branch actually puts in CI, run as a branch would run it.
const strict = fliJson(context, ['release:check', '--from', 'db/before.lite', '--strict', '--json'], app)

if (!await must(context, {
  ok:    strict.code === 0,
  name:  'and --strict lets it through',
  asked: 'exit 0',
  got:   `exit ${strict.code}`,
}, {
  likely: 'something else in the schema is a contract — the findings are above',
})) return
```
