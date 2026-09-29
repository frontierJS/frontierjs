---
title: register:amend
description: Add to an open issue row — the detail appended after ` · `, Verified re-dated today
alias: amend
examples:
  - fli amend FJS-1546 --detail "Seen again in the linear stressor, 40 grep calls · [PLAN.md](../fjs-prototypes/linear/PLAN.md)"
args:
  -
    name: id
    description: The issue's id, as ISSUES.md writes it
    required: true
flags:
  detail:
    char: d
    type: string
    description: What was found and where — appended to the Detail cell, links joined with ` · `
---

```js
const { amendIssue }       = await import(resolve(global.fliRoot, 'core/amend.js'))
const { findRegisterRoot } = await import(resolve(global.fliRoot, 'core/registers.js'))

const root = findRegisterRoot(process.cwd()) ?? context.paths.root

const out = amendIssue({ root, id: arg.id, detail: flag.detail })

echo('')
if (!out.ok) {
  echo(`  ✗ ${out.reason}`)
  echo('')
  process.exitCode = 1
  return
}

echo(`  ✓ ${out.id} amended — ${out.file}:${out.line}`)
echo('    register:check agrees with the result')
echo('')
```

## What it writes

`--detail` appended to the row's Detail cell after ` · `. Nothing the row
already says is replaced, because that is how the defect was measured. On an
open row the Verified cell becomes today, since an amend is a fresh sighting; a
§ Needs a decision row has no such column and takes the append alone.

A closed row is refused: a defect that came back is a new row citing the old
one, `fli file`. `register:check` runs over the result, and a write it finds a
new error in is put back and refused.
