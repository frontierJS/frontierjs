---
title: ws:hazards
description: Which fli check rule grades each live hazard — one row per hazard, and the gap named
examples:
  - fli ws:hazards
  - fli ws:hazards --check
  - fli ws:hazards --gaps
flags:
  check:
    char: c
    type: boolean
    description: Compare the committed snapshot against the tree; exit 1 if it is stale
    defaultValue: false
  gaps:
    char: g
    type: boolean
    description: Print only the hazards no rule grades
    defaultValue: false
---

The realm skills hold one bullet per live hazard, and `FJS-D133` makes
`fli check`'s rule table where that catalog executes. This asks which bullets a
rule has reached. A rule declares `hazard: '<realm>: <prefix of the bold lead>'`
in `core/checks.js`; the table is read off that, and `fli check`'s
`hazard-enforcer` reds a key that matches no bullet or two.

<script>
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
</script>

```js
const { hazardCoverage, renderHazards } =
  await import(resolve(global.fliRoot, 'core/hazards.js'))
const { RULES } = await import(resolve(global.fliRoot, 'core/checks.js'))

const root = await $.wsRoot()
if (!root) { log.error('No workspace found from here'); process.exitCode = 1; return }

const cov = hazardCoverage({ root, rules: RULES })

if (!cov.hazards.length) {
  echo('')
  echo('  ✗  no realm skill under .claude/skills/ lists a hazard — nothing to grade.')
  echo('')
  process.exitCode = 1
  return
}

if (flag.gaps) {
  echo('')
  for (const h of cov.hazards.filter(h => !h.rules.length)) echo(`  ⚠  ${h.realm} · ${h.section} · ${h.lead}`)
  echo('')
  return
}

const out  = renderHazards(cov)
const file = resolve(root, 'hazards.snapshot.md')

if (flag.check) {
  const have = existsSync(file) ? readFileSync(file, 'utf8') : null
  echo('')
  if (have === null) {
    echo('  ✗  hazards.snapshot.md is missing. Run `fli ws:hazards` to write it.')
    process.exitCode = 1
  } else if (have !== out) {
    echo('  ✗  hazards.snapshot.md is stale. Run `fli ws:hazards`.')
    process.exitCode = 1
  } else {
    echo('  ✓  hazards.snapshot.md')
  }
  echo('')
  return
}

writeFileSync(file, out)

const graded = cov.hazards.filter(h => h.rules.length).length
echo('')
echo('  ✓  hazards.snapshot.md')
echo(`  ${graded} of ${cov.hazards.length} hazard(s) have a rule`)
for (const u of cov.unresolved) echo(`  ✗  rule \`${u.rule}\` names hazard '${u.key}', which matches ${u.matches} bullets — it must match one`)
if (cov.unresolved.length) process.exitCode = 1
echo('')
```
