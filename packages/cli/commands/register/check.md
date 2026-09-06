---
title: register:check
description: Grade ISSUES.md, DECISIONS.md and IDEAS/ against the rules they state about themselves
examples:
  - fli register:check
  - fli register:check --strict
  - fli register:check --json
  - fli register:check --stale-days 30
flags:
  strict:
    char: s
    type: boolean
    description: Fail on warnings as well as errors
    defaultValue: false
  json:
    char: j
    type: boolean
    description: Emit the findings as JSON
    defaultValue: false
  rules:
    char: r
    type: boolean
    description: List the rules and what each one is for, without running them
    defaultValue: false
  stale-days:
    type: string
    description: Days before an open row counts as unverified; 0 turns the rule off
    defaultValue: '60'
---

```js
// `args` is already bound in the compiled shim — a second declaration is a
// SyntaxError the compiler reports as a clean build (Invariant 15).
const { runRegisterCheck, formatRegisterCheck, RULES } =
  await import(resolve(global.fliRoot, 'core/register-check.js'))

const root = context.paths.root

if (flag.rules) {
  echo('')
  for (const rule of RULES) {
    echo(`  ${rule.level === 'error' ? '✗' : '⚠'}  ${rule.id.padEnd(18)} ${rule.what}`)
  }
  echo('')
  echo('  An error is a register contradicting itself. A warning is one that is thin.')
  echo('')
  return
}

const staleDays = Number.parseInt(flag['stale-days'] ?? '60', 10)

// A root with no register at all is a refusal rather than a pass, and it is the
// commonest way to reach one: `fli` walks up to the nearest package root, so
// this run from inside a package reads that package's directory. Printed as a
// message and not a stack, because the fix is to change directory.
let result
try {
  result = runRegisterCheck({ root, staleDays: Number.isFinite(staleDays) ? staleDays : 60 })
} catch (err) {
  echo('')
  echo(`  fli register:check\n`)
  for (const line of String(err.message).split('\n')) echo(`  ${line}`)
  echo('')
  process.exitCode = 1
  return
}

if (flag.json) {
  echo(JSON.stringify(result, null, 2))
  if (result.errors.length || (flag.strict && result.warnings.length)) process.exitCode = 1
  return
}

echo('')
echo('  fli register:check\n')
for (const line of formatRegisterCheck(result)) echo(line)
echo('')

if (result.errors.length) {
  process.exitCode = 1
} else if (flag.strict && result.warnings.length) {
  echo(`  --strict: ${result.warnings.length} warning(s) count as failures`)
  echo('')
  process.exitCode = 1
}
```

## What it reads

Nothing is configured. The registers are found where a project keeps them —
`ISSUES.md` and `ISSUES_ARCHIVE.md` at the root, `DECISIONS.md` beside them,
`IDEAS/*.md` in a directory. A register a project does not have is absent from
the report rather than a failure: an app with no `IDEAS/` has not done anything
wrong. The report names the ones it read, so a small count is legible as a
small register.

**A root holding NONE of them is refused**, and the exit code is 1. The two
cases are not the same claim: a project with two registers is being graded on
two, while a directory with none is one this command cannot answer for, and
`0 open · 0 rulings · ✓ every register agrees with itself` is a pass over a
question nobody asked. It is also the likely way to arrive — `fli` walks up to
the nearest package root, so a run from inside `packages/<pkg>` grades that
package's own directory, which is what the root `CLAUDE.md` tells everyone to
do before running anything else.

## Errors and warnings are two different claims

An **error** is a register that contradicts itself, and none of them can be
true on purpose:

- **`duplicate-id`** — two records of the same kind under one id. An id is never
  reused, so the second one is a defect wearing the first one's name. A ruling
  and the question that asked for it legitimately share an id across registers
  and are not reported.
- **`unknown-ref`** — a record cites an id no register holds. Either the id was
  renamed, or the record it points at was never written.
- **`dead-link`** — a linked path is in neither the file's own directory nor the
  workspace root. Closed records are exempt: their links describe the code as it
  was, and a file renamed by the fix is the fix working.
- **`unknown-status`**, **`unknown-severity`**, **`malformed-date`** — a value
  outside the vocabulary the register declares in its own conventions table.

A **warning** is a register that is thin, and every one is a legitimate state to
be in on the way somewhere:

- **`unnamed-ruling`** — a ruling with no id. Nothing can cite it, so it cannot
  close an issue or be pointed at from a code comment.
- **`missing-anchor`** — an open row with no `<a id>`, so nothing can deep-link
  it.
- **`stale-verified`** — an open row nobody has re-checked inside `--stale-days`.

## The one rule that reads the clock

`stale-verified` is the only finding whose answer changes overnight, which means
this command's output is **not reproducible** and must never feed a committed
snapshot. `--stale-days 0` turns it off for a caller that needs a stable answer.

## In CI

```
fli register:check
```

Exits 1 on any error. `--strict` makes warnings count too, which is what a
project wants once its registers are clean — before that it fails on the
backlog rather than on the change, and a check that is red on arrival is a
check everybody learns to skip.
