---
title: 04-contract
description: The same column, required — and the deploy you cannot undo
---

## Contract

One character:

```text
priority  Int?   →   priority  Int
```

Required, with no default. Now the release still serving is a problem: every
write it makes omits the column, and every one of those writes is **refused**.
The two releases cannot share the database, so this deploy is the pivot.

```console
fli release:check --from db/before.lite
```

**contract** — and the finding does not stop at the verdict. It hands back the
split:

```text
expand:   declare `priority` optional on `Note` and deploy — N-1 keeps serving
backfill: give every existing `Note` a `priority` — required before the contract can pass
contract: declare it required and deploy again — this deploy is the pivot
```

Three deploys instead of one. That is the actual cost of a required column on a
table with rows in it, and the reason to know it now is that the alternative is
finding out during the deploy.

The middle step is the one nothing can check for you: whether the backfill has
**run** is a fact about the deployed database, not about this tree, and the
finding says so rather than pretending. What it does carry is the model and the
field, so `fli` can look for a `defineBackfill` naming that pair.

```js
if (!await narrate(context)) return

context.config.__step = 4

if (!needs(context, ['appDir', 'baseline'], { from: '02-baseline' })) return

const app  = context.config.appDir
const edit = addNoteField(context, '  priority  Int')

if (!await must(context, {
  ok:    edit.ok,
  name:  'priority is now required',
  asked: 'the column declared without ?',
  got:   edit.ok ? 'it is' : edit.why,
}, { likely: 'the seed has no `model Note {` block to change' })) return

const r = fliJson(context, ['release:check', '--from', 'db/before.lite', '--json'], app)
const f = (r.json?.findings ?? []).find(x => x.subject === 'Note.priority')

if (!await must(context, {
  ok:    r.json?.verdict === 'contract',
  name:  'the verdict is contract — this deploy is the pivot',
  asked: 'verdict: contract',
  got:   r.json ? `verdict: ${r.json.verdict}` : `no JSON — ${(r.stderr || r.stdout).slice(0, 200)}`,
}, {
  likely:    'the column is still optional',
  reproduce: `cd ${app} && fli release:check --from db/before.lite`,
})) return

// The verdict alone is a grade. What makes it usable is the plan under it, and
// the machine-readable half a later command can act on.
if (!await must(context, {
  ok:    Array.isArray(f?.split) && f.split.length === 3,
  name:  'and it hands back the three-deploy split',
  asked: 'expand → backfill → contract',
  got:   f?.split ? `${f.split.length} step(s)` : 'no split on the finding',
}, {
  likely: 'the finding was raised by a different rule — the JSON is above',
})) return

if (!await must(context, {
  ok:    f?.needsBackfill?.model === 'Note' && f?.needsBackfill?.field === 'priority',
  name:  'naming the column that has to be filled first',
  asked: 'needsBackfill: Note.priority',
  got:   JSON.stringify(f?.needsBackfill ?? null),
}, {
  likely: 'the middle step was described in prose and not in the payload',
})) return

const strict = fliJson(context, ['release:check', '--from', 'db/before.lite', '--strict', '--json'], app)

if (!await must(context, {
  ok:    strict.code !== 0,
  name:  '--strict refuses it',
  asked: 'a non-zero exit',
  got:   `exit ${strict.code}`,
}, {
  likely: 'strict is not reading the same baseline',
})) return
```
