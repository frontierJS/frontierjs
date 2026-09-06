---
title: 05-access
description: A change that touches no column, and is still a contract
---

## Access is part of the comparison

Put `priority` back to optional, and change something that is not a column at
all:

```text
@@gate("0.4.4.6")   →   @@gate("4.4.4.6")
```

No table changes. No migration is generated. And it is still a **contract**,
because the question was never *do the tables line up* — it is *can the release
still serving go on serving*. Raising a read gate takes reads away from callers
it was answering a minute ago.

```text
gate "0.4.4.6" → "4.4.4.6" — read needs USER, and N-1 callers below it are refused
```

This is the half no generic migration tool can reach, and it fails in the
quietest way there is: adding an `@@allow` empties a screen with a **200**. The
finding is marked `narrows` — the same word `fli test:access --from` uses when
it reports what a branch did to who may do what.

```js
if (!await narrate(context)) return

context.config.__step = 5

if (!needs(context, ['appDir', 'baseline'], { from: '02-baseline' })) return

const app = context.config.appDir

const back = addNoteField(context, '  priority  Int?')
if (!await must(context, {
  ok:    back.ok,
  name:  'priority goes back to optional',
  asked: 'the column optional again',
  got:   back.ok ? 'it is' : back.why,
}, { likely: 'the seed has no `model Note {` block to change' })) return

const raised = editSchema(context, '@@gate("0.4.4.6")', '@@gate("4.4.4.6")')
if (!await must(context, {
  ok:    raised.ok,
  name:  'reads on Note now need a signed-in caller',
  asked: 'the gate raised from 0 to 4',
  got:   raised.ok ? (raised.already ? 'it was already raised' : 'it was raised') : raised.why,
}, { likely: 'the scaffold wrote a different gate — raise the first number by hand' })) return

const r = fliJson(context, ['release:check', '--from', 'db/before.lite', '--json'], app)
const f = (r.json?.findings ?? []).find(x => x.access)

if (!await must(context, {
  ok:    r.json?.verdict === 'contract',
  name:  'a gate raise is a contract, with no column touched',
  asked: 'verdict: contract',
  got:   r.json ? `verdict: ${r.json.verdict}` : `no JSON — ${(r.stderr || r.stdout).slice(0, 200)}`,
}, {
  likely:    'access is not being compared — the findings are above',
  reproduce: `cd ${app} && fli release:check --from db/before.lite`,
})) return

if (!await must(context, {
  ok:    f?.access === 'narrows',
  name:  'and the finding says which direction it moved',
  asked: 'access: narrows',
  got:   f ? `access: ${f.access}` : 'no finding carries an access verdict',
}, {
  likely: 'the gate change was classified as a column change',
})) return

log.info('')
log.info(`  ${f.detail}`)
log.info('')

// ── and then apply it ───────────────────────────────────────────────────────
//
// The lesson has been about verdicts, and the verdict on what is left is
// expand: `priority` is optional and N-1 keeps serving. So the honest end is to
// apply it, which is what you would do next.
//
// It is also what keeps this app usable. Every step above edited the SCHEMA and
// nothing wrote a table, so the app now declares a column its database does not
// have — and the next thing to write a Note through the API is refused with
// `table note has no column named priority`, three lessons later, by a page
// that has nothing to do with this one.
log.info('applying it — the verdict on what is left is expand, and a schema the')
log.info('database has not caught up with is a 500 on the next write')
pushSchema(context)

if (!await must(context, probe.sqliteRow({
  db:     join(app, 'db', 'app.db'),
  sql:    "select name from pragma_table_info('note') where name = 'priority'",
  expect: (rows) => rows.length === 1,
  name:   'the column the schema declares is in the table',
}), {
  likely:    'db:push did not run — its output is above',
  reproduce: `cd ${app} && fli db:push`,
})) return
```
