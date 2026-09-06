---
title: 05-mutate
description: What grades the checks — a schema deliberately broken
---

## Grading the grader

Every step so far ended green, which proves less than it looks. A suite that
passes says nothing about what it does not look at, and *what it does not look
at* is exactly the thing you cannot see from inside it.

So break the schema on purpose:

```console
litestone mutate
```

Drop a `@@gate`. Grade one down. Remove a `@guarded`. Widen a `@length`. Then
run the checks **derived from the original schema** against a database built
from the **mutant**. Anything that still passes is something nothing looks at,
and it names itself.

**The direction is the whole design.** Expectations come from the original and
the database comes from the mutant. Derive both from the mutant and you have the
oracle problem in its purest form: drop a `@@gate` and the ladder loses the very
rows that would have caught it, every mutant survives, and the score reads 100%.

A `.lite` file is small and declarative, so the mutation space is **enumerable**
rather than combinatorial — one mutant per attribute occurrence. This app has
about three dozen.

**A survivor is a fact about the CHECKS, not about the schema.** Two are known
and expected, and the command says so: a `@unique` on a nullable column (SQLite
takes any number of NULLs, so there is no duplicate to try) and a create-only
policy (checked by one interpreter, so nothing independent can grade it).

```js
if (!await narrate(context)) return

context.config.__step = 5

if (!needs(context, ['appDir'], { from: '01-app' })) return

const app = context.config.appDir

// Roughly ten seconds: every mutant is a fresh database, and the template copy
// is what makes that affordable at all.
const run = probe.command({
  bin:      'bunx',
  args:     ['litestone', 'mutate', '--schema', 'db/schema.lite'],
  cwd:      app,
  needle:   /killed/,
  describe: 'a score',
  name:     'the schema is mutated and the checks are graded',
})

if (!await must(context, run, {
  likely:    'litestone is not installed in this app, or the schema declares nothing to mutate',
  reproduce: `cd ${app} && bunx litestone mutate`,
})) return

// The score is read back rather than trusted. A run that mutated nothing also
// prints no failures, and 0/0 is not a passing suite — it is an absent one.
const killed = /(\d+)\s*\/\s*(\d+)\s+graded/.exec(run.detail ?? '')
  ?? /(\d+)%\s+killed\s+\D*(\d+)\s*\/\s*(\d+)/.exec(run.detail ?? '')

if (!await must(context, {
  ok:    /\d+ mutants/.test(run.detail ?? ''),
  name:  'there were mutants to grade',
  asked: 'at least one mutation of this schema',
  got:   killed ? killed[0] : 'the run reported no mutant count',
  detail: (run.detail ?? '').split('\n').slice(-20).join('\n'),
}, {
  likely: 'this schema declares no @@gate, @@allow, @guarded or validator — there is nothing to mutate',
})) return

// The probe CAPTURED the output, so a reader would otherwise be told a score
// exists and never see it — which is the one thing in this lesson worth looking
// at. Printed from the mutant count to the end, with litestone's own stderr
// dropped: every mutant opens a database, and each one announces the audit
// directory it created, which is thirty-six paragraphs over the report.
const noise  = /^\[litestone\]|^ {6,}(path:|cwd:|A relative)/
const report = (run.detail ?? '').split('\n').filter(l => !noise.test(l))
const from   = report.findIndex(l => /mutants/.test(l))
log.info('')
for (const line of report.slice(from === -1 ? 0 : from)) log.info(`  ${line}`)

log.info('')
log.info('  a survivor is a hole in the CHECKS, and it names itself')
log.info('  the two expected ones are named in the output above')
log.info('')

remember(context, '05-mutate', { mutated: true })
```
