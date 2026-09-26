---
title: register:decide
description: Rule on an open question — write the ruling to DECISIONS.md and strike the question in its paper
alias: decide
examples:
  - fli decide scoped-sql:encrypted-columns A --section "Access control"
  - fli decide scoped-sql:encrypted-columns B --section "Access control" --why "an operator reads ciphertext on purpose"
args:
  -
    name: id
    description: The question's id, as `fli decisions` prints it
    required: true
  -
    name: pick
    description: The option letter
    required: true
flags:
  section:
    char: s
    type: string
    description: The DECISIONS.md section the ruling goes under
  why:
    char: w
    type: string
    description: The reason — required when the pick is not the recommendation
---

```js
const { decide }          = await import(resolve(global.fliRoot, 'core/decide.js'))
const { rulingSections }  = await import(resolve(global.fliRoot, 'core/decisions.js'))

const { findRegisterRoot } = await import(resolve(global.fliRoot, 'core/registers.js'))

// The nearest package.json declaring `registers`, so a run from inside a
// package or a surface means the project's registers.
const root = findRegisterRoot(process.cwd()) ?? context.paths.root

if (!flag.section) {
  echo('')
  echo('  --section is required. DECISIONS.md has:')
  for (const s of rulingSections(root)) echo(`    ${s}`)
  echo('')
  process.exitCode = 1
  return
}

const out = decide({ root, id: arg.id, pick: arg.pick, why: flag.why ?? '', section: flag.section })

echo('')
if (!out.ok) {
  echo(`  ✗ ${out.reason}`)
  echo('')
  process.exitCode = 1
  return
}

echo(`  ✓ ${out.ruling} — ${out.question} → ${out.pick}`)
for (const f of out.files) echo(`    wrote ${f}`)
echo('    register:check agrees with the result')
echo('')
```

## What it writes

One act, two files: a ruling prepended to the named section of `DECISIONS.md`
under the next free `FJS-D` id, and the question struck in its paper with that
id beside the answer — the paper's own `~~**question**~~ **Answered …**`
convention. `register:check` runs over the result, and a write it finds a new
error in is put back and refused, so neither file is left half answered.

A pick that follows the paper's recommendation takes its reason from the
recommendation. A pick against it needs `--why`, because a ruling that
overrides the written argument without saying why is one nobody can reread.
