---
title: ws:invariants
description: What fails when an invariant stops being true — one row per invariant, and the gap named
examples:
  - fli ws:invariants
  - fli ws:invariants --check
  - fli ws:invariants --gaps
flags:
  check:
    char: c
    type: boolean
    description: Compare the committed snapshot against the tree; exit 1 if it is stale
    defaultValue: false
  gaps:
    char: g
    type: boolean
    description: Print only the invariants nothing grades
    defaultValue: false
---

`CLAUDE.md` § Invariants is the top of the prose stack. This asks the question
nothing else does: **is there anything that fails when one of them stops being
true?** A `fli check` rule declares the invariant it serves and that half is
read off the rule table; every other enforcer is declared in
`core/invariants.js` and checked to resolve by `fli check`'s
`invariant-enforcer`.

<script>
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
</script>

```js
const { invariantCoverage, renderInvariants } =
  await import(resolve(global.fliRoot, 'core/invariants.js'))
const { RULES } = await import(resolve(global.fliRoot, 'core/checks.js'))

const root = await context.wsRoot()
if (!root) { log.error('No workspace found from here'); process.exitCode = 1; return }

const rows = invariantCoverage({ root, rules: RULES })

if (!rows.length) {
  echo('')
  echo('  ✗  CLAUDE.md declares no numbered Invariants section — nothing to grade.')
  echo('')
  process.exitCode = 1
  return
}

if (flag.gaps) {
  const gap = rows.filter(r => !r.covered)
  echo('')
  if (!gap.length) echo('  ✓  every invariant has something that fails when it stops being true')
  for (const r of gap) echo(`  ⚠  ${String(r.n).padStart(2)}. ${r.title}`)
  echo('')
  return
}

const unresolved = rows.flatMap(r =>
  r.enforcers.filter(e => !e.resolved).map(e => ({ n: r.n, e })))

const out  = renderInvariants(rows)
const file = resolve(root, 'invariants.snapshot.md')

if (flag.check) {
  const have = existsSync(file) ? readFileSync(file, 'utf8') : null
  echo('')
  if (have === null) {
    echo('  ✗  invariants.snapshot.md is missing. Run `fli ws:invariants` to write it.')
    process.exitCode = 1
  } else if (have !== out) {
    echo('  ✗  invariants.snapshot.md is stale. Run `fli ws:invariants`.')
    process.exitCode = 1
  } else {
    echo('  ✓  invariants.snapshot.md')
  }
  echo('')
  return
}

writeFileSync(file, out)

const covered = rows.filter(r => r.covered).length
echo('')
echo('  ✓  invariants.snapshot.md')
echo(`  ${covered} of ${rows.length} invariant(s) have an enforcer`)
for (const r of rows.filter(r => !r.covered)) echo(`  ⚠  ${r.n}. ${r.title} — nothing grades this`)
for (const u of unresolved) echo(`  ✗  Invariant ${u.n} names ${u.e.kind} \`${u.e.at}\`, which does not resolve`)
if (unresolved.length) process.exitCode = 1
echo('')
```
