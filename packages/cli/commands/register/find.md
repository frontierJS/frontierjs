---
title: register:find
description: Search the registers — every issue row and ruling holding all the terms, id and title only, open first
alias: find
examples:
  - fli find stressor issues
  - fli find FJS-1546
  - fli find junction idempotency --limit 5
args:
  -
    name: terms
    description: Words every hit must hold, case-folded — an id, a word from the title, a package
    variadic: true
flags:
  limit:
    char: l
    type: string
    description: How many hits to print
    defaultValue: '20'
---

```js
const { findRows }         = await import(resolve(global.fliRoot, 'core/find.js'))
const { findRegisterRoot } = await import(resolve(global.fliRoot, 'core/registers.js'))

const root  = findRegisterRoot(process.cwd()) ?? $.paths.root
const limit = Math.max(1, Number(flag.limit) || 20)

const out = findRows({ root, terms: arg.terms, limit })

echo('')
if (!out.ok) {
  echo(`  ✗ ${out.reason}`)
  echo('')
  process.exitCode = 1
  return
}

if (!out.total) {
  echo(`  no row or ruling holds all of: ${arg.terms}`)
  echo('')
  return
}

const clip = (s, n) => s.length > n ? `${s.slice(0, n - 1)}…` : s
let bodyOnly = false
for (const h of out.hits) {
  if (h.where === 'body' && !bodyOnly) {
    bodyOnly = true
    echo('  ── only in the body ──')
  }
  const state = [h.status, h.severity].filter(Boolean).join(' · ')
  echo(`  ${h.id.padEnd(10)} ${state.padEnd(16)} ${h.file}:${h.line}`)
  echo(`             ${clip([h.area, h.title].filter(Boolean).join(' — '), 110)}`)
}
if (out.total > out.hits.length) echo(`  … ${out.total - out.hits.length} more — add a term`)
echo('')
```

## What it searches

`ISSUES.md` — the open tables, § Needs a decision and § Closed —
`ISSUES_ARCHIVE.md` and `DECISIONS.md`, read through the same reader
`register:check` grades with. A hit holds every term somewhere in its id, area,
title or body, case-folded.

## What it prints

The id, status and severity, `file:line`, and the area and title — never the
body, which is what made a grep over this register cost 29k characters a match.
Hits whose id, area or title hold every term come first, and open rows before
rulings before closed rows within that; the rest are listed under *only in the
body*. Read one row with its `file:line`.

**Run it before `fli file`.** A second sighting of a filed defect is `fli
amend <id> --detail`, not a new row.
