---
title: register:close
description: Close an open issue — move its row into § Closed with the date and how it was fixed
alias: close
examples:
  - fli close ELA-001 --how "Uncommented the two fields; texted STOP, row saved with smsAllowed=false"
args:
  -
    name: id
    description: The issue's id, as ISSUES.md writes it
    required: true
flags:
  how:
    char: w
    type: string
    description: What changed, and how it was proven — the closed row's How column
---

```js
const { closeIssue }       = await import(resolve(global.fliRoot, 'core/close.js'))
const { findRegisterRoot } = await import(resolve(global.fliRoot, 'core/registers.js'))

// The nearest package.json declaring `registers`, so a run from inside a
// package or a surface means the project's registers.
const root = findRegisterRoot(process.cwd()) ?? context.paths.root

const out = closeIssue({ root, id: arg.id, how: flag.how ?? '' })

echo('')
if (!out.ok) {
  echo(`  ✗ ${out.reason}`)
  echo('')
  process.exitCode = 1
  return
}

echo(`  ✓ ${out.id} closed — ${out.file}:${out.line}`)
echo('    register:check agrees with the result')
echo('')
```

## What it writes

One edit to `ISSUES.md`: the row leaves its open table and becomes the top row
of § Closed, in that table's four columns. The id cell is kept whole, anchor
included, so every link to the row still lands on it. The area is folded in
front of the title, and the How column is `--how` followed by every link the
Detail cell held, so the closed row still says where the defect lived.

`register:check` runs over the result, and a write it finds a new error in is
put back and refused. Moving old closures into `ISSUES_ARCHIVE.md` is a
separate trim, `fli register:archive`.
