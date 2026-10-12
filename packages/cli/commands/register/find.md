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
const { plural }           = await import(resolve(global.fliRoot, 'core/text.js'))

const root  = findRegisterRoot(process.cwd()) ?? $.paths.root
const limit = Math.max(1, Number(flag.limit) || 20)

const out = findRows({ root, terms: arg.terms, limit })

echo('')
if (!out.ok) {
  echo(chalk`  {red ✗} ${out.reason}`)
  echo('')
  process.exitCode = 1
  return
}

const terms = [arg.terms].flat().join(' ')
if (!out.total) {
  echo(chalk`  {dim no row or ruling holds all of} {bold ${terms}}`)
  echo('')
  return
}

// A status no table names here prints unstyled rather than failing the row.
const STATUS = {
  'open':           chalk.green,
  'stale?':         chalk.yellow,
  'needs a ruling': chalk.magenta,
  'ruling':         chalk.blue,
}
const SEVERITY = { S1: s => chalk`{bold.red ${s}}`, S2: chalk.yellow, S4: chalk.gray }
const paint = (table, s) => (table[s] ?? String)(s)

// The terminal wraps an overlong title back to column 0, under the id column.
const width = Math.max(40, (process.stdout.columns || 124) - 13)
const clip  = (s, n) => s.length > n ? `${s.slice(0, n - 1)}…` : s

echo(chalk`  {bold ${plural(out.total, 'hit')}} {dim for} ${terms}`)
echo('')

let bodyOnly = false
for (const h of out.hits) {
  if (h.where === 'body' && !bodyOnly) {
    bodyOnly = true
    echo(chalk.dim('  ── only in the body ──'))
  }
  // A severity of `decision` repeats what *needs a ruling* already says.
  const severity = h.severity === 'decision' ? null : h.severity
  const state    = [h.status, severity].filter(Boolean)
  const pad      = ' '.repeat(Math.max(1, 17 - state.join(' · ').length))
  const settled  = !(h.status in STATUS)

  const area  = h.area ? clip(h.area, width) : ''
  const title = clip(h.title ?? '', Math.max(10, width - (area ? area.length + 3 : 0)))
  const head  = chalk`{bold ${h.id.padEnd(10)}} ${[paint(STATUS, h.status), severity && paint(SEVERITY, severity)].filter(Boolean).join(chalk.dim(' · '))}${pad}${chalk.dim(chalk.fileLink(`${h.file}:${h.line}`, resolve(root, h.file), h.line))}`
  const body  = area ? chalk`{cyan ${area}} {dim —} ${title}` : title

  echo(settled ? chalk.dim(`  ${head}`) : `  ${head}`)
  echo(settled ? chalk.dim(`             ${body}`) : `             ${body}`)
}
if (out.total > out.hits.length) echo(chalk.dim(`  … ${out.total - out.hits.length} more — add a term`))
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
