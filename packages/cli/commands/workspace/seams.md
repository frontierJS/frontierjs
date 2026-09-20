---
title: ws:seams
description: Who owns each named cross-package handoff — the stated owner, resolved against the tree
examples:
  - fli ws:seams
  - fli ws:seams --check
  - fli ws:seams --gaps
flags:
  check:
    char: c
    type: boolean
    description: Compare the committed snapshot against the tree; exit 1 if it is stale
    defaultValue: false
  gaps:
    char: g
    type: boolean
    description: Print only the seams nobody has assigned an owner
    defaultValue: false
---

The `bridge-index` skill is the seam list and every owner claim in it. This asks
the half nothing else does: **does the stated owner exist, is the name in it, and
how many other files declare the same name?** Invariants 4 and 5 are what it
serves. A seam nobody has assigned is reported as `none` and does not fail;
a stated path that has gone fails, because advice that fails when taken is worse
than no advice.

<script>
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
</script>

```js
const { seamOwnership, renderSeams, SKILL } =
  await import(resolve(global.fliRoot, 'core/seams.js'))

const root = await context.wsRoot()
if (!root) { log.error('No workspace found from here'); process.exitCode = 1; return }

const rows = seamOwnership({ root })

if (!rows.length) {
  echo('')
  echo(`  ✗  ${SKILL} holds no seam bullets — nothing to grade.`)
  echo('')
  process.exitCode = 1
  return
}

if (flag.gaps) {
  const gap = rows.filter(r => r.owner === null)
  echo('')
  if (!gap.length) echo('  ✓  every seam names an owner')
  for (const r of gap) echo(`  ⚠  ${r.names[0]} — ${r.section}`)
  echo('')
  return
}

const broken  = rows.filter(r => r.broken)
const missing = rows.filter(r => r.owner && r.ownerExists && r.kind === 'fn' && !r.inOwner)
const out     = renderSeams(rows)
const file    = resolve(root, 'seams.snapshot.md')

if (flag.check) {
  const have = existsSync(file) ? readFileSync(file, 'utf8') : null
  echo('')
  if (have === null) {
    echo('  ✗  seams.snapshot.md is missing. Run `fli ws:seams` to write it.')
    process.exitCode = 1
  } else if (have !== out) {
    echo('  ✗  seams.snapshot.md is stale. Run `fli ws:seams`.')
    process.exitCode = 1
  } else {
    echo('  ✓  seams.snapshot.md')
  }
  echo('')
  return
}

writeFileSync(file, out)

const owned = rows.filter(r => r.owner !== null).length
echo('')
echo('  ✓  seams.snapshot.md')
echo(`  ${owned} of ${rows.length} seam(s) name an owner`)
for (const r of broken)  echo(`  ✗  ${r.names[0]} names \`${r.owner}\`, which does not resolve`)
for (const r of missing) echo(r.reexport
  ? `  ⚠  ${r.names[0]} names \`${r.owner}\`, which only re-exports it from \`${r.reexport}\``
  : `  ⚠  ${r.names[0]} names \`${r.owner}\`, which does not declare \`${r.id}\``)
if (broken.length) process.exitCode = 1
echo('')
```
