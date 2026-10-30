---
title: register:next
description: What to work on next — the open register ranked, every row printed with the terms that scored it
alias: next
examples:
  - fli next
  - fli next --pkg junction
  - fli next --sev S3,S4
  - fli next --limit 25
  - fli next --by seam
  - fli next --json
flags:
  pkg:
    char: p
    type: string
    description: Only rows filed against this package
  sev:
    char: s
    type: string
    description: Only rows of these severities, comma-separated (S1,S2)
  limit:
    char: l
    type: string
    description: How many ready rows to print
    defaultValue: '10'
  by:
    type: string
    choices: [seam]
    description: Group the open rows by the segment they name, most rows first
  json:
    char: j
    type: boolean
    description: Emit the whole ranking as JSON
    defaultValue: false
---

```js
const { rankNext, blockedLine, bySeam } = await import(resolve(global.fliRoot, 'core/next.js'))

const { findRegisterRoot } = await import(resolve(global.fliRoot, 'core/registers.js'))

// The nearest package.json declaring `registers`, so a run from inside a
// package or a surface means the project's registers.
const root = findRegisterRoot(process.cwd()) ?? $.paths.root
const sev  = flag.sev ? flag.sev.split(',').map(s => s.trim().replace(/^s(\d)$/, 'S$1')).filter(Boolean) : null
const pkg  = flag.pkg ? String(flag.pkg).split(',').map(s => s.trim()).filter(Boolean) : null
const out  = rankNext(root, { pkg, sev })

const scope = (pkg ? ` in ${pkg.join(', ')}` : '') + (sev ? ` at ${sev.join(', ')}` : '')

// A title past the edge wraps into the next row; piped output is whole.
const fit = (text, used) => {
  const room = process.stdout.isTTY ? Math.max(20, process.stdout.columns - used) : Infinity
  return text.length > room ? text.slice(0, room - 1) + '…' : text
}
const SEV_TONE = { S1: chalk.red, S2: chalk.red, S3: chalk.yellow, S4: chalk.cyan }
const sevTone  = (s) => (SEV_TONE[String(s).slice(0, 2)] ?? chalk.dim)(s)

// Every open row in scope, blocked and owed rulings too: a seam collecting
// rows is the finding whether or not they can start.
if (flag.by === 'seam') {
  const rows    = [...out.ready, ...out.blocked, ...out.decide.framed, ...out.decide.rows].sort((a, b) => b.score - a.score)
  const grouped = bySeam(rows)
  if (flag.json) {
    echo(JSON.stringify(grouped, null, 2))
    return
  }
  const named = rows.length - grouped.none
  echo('')
  echo(`  ${chalk.bold('Seams')}  ${chalk.dim(`·  ${grouped.seams.length} seam(s) over ${named} row(s)${scope}  ·  ${grouped.none} name none`)}`)
  echo('')
  for (const g of grouped.seams) {
    echo(`  ${chalk.bold(String(g.count).padStart(3))}  ${chalk.cyan(g.seam)}`)
    for (const r of g.rows) {
      echo(`       ${chalk.dim(r.id.padEnd(9))} ${sevTone(r.severity.padEnd(8))} ${chalk.dim(String(r.score).padStart(3))}  ${fit(r.title, 31)}`)
    }
    echo('')
  }
  if (!grouped.seams.length) echo(chalk.dim('  No open row names a seam yet.\n'))
  return
}

if (flag.json) {
  echo(JSON.stringify(out, null, 2))
  return
}

const limit = Math.max(1, Number.parseInt(flag.limit ?? '10', 10) || 10)

echo('')
echo(`  ${chalk.bold('Next')}  ${chalk.dim(`·  ${out.ready.length} ready${scope}  ·  ${out.blocked.length} blocked  ·  ${out.decide.decidable} to decide`)}`)
echo('')

if (out.decide.decidable) {
  echo(`  ${chalk.yellow('decide first:')} ${out.decide.decidable} question(s) have options written — ${chalk.cyan('fli decisions')}`)
  echo('')
}
if (out.decide.framed.length) {
  echo(chalk.dim('  waiting on a ruling, options written — fli decide:'))
  for (const r of out.decide.framed) echo(`    ${chalk.yellow(r.id)}  ${fit(r.title, 14)}`)
  echo('')
}
if (out.decide.rows.length) {
  echo(chalk.dim('  waiting on a ruling, with no options written yet — /frame-next:'))
  for (const r of out.decide.rows) echo(`    ${chalk.yellow(r.id)}  ${fit(r.title, 14)}`)
  echo('')
}

out.ready.slice(0, limit).forEach((r, i) => {
  const note = [r.probeFirst && 'stale? — probe before acting', r.byHand && 'by hand', r.env && `env: ${r.env}`].filter(Boolean)
  const flag_ = note.length ? '  ' + chalk.yellow(`(${note.join(') (')})`) : ''
  echo(`  ${chalk.dim(String(i + 1).padStart(2) + '.')} ${chalk.bold(r.id.padEnd(9))} ${String(r.score).padStart(3)}  ${chalk.cyan(r.pkg.join(' · '))}${flag_}`)
  echo(`      ${fit(r.title, 8)}`)
  echo(chalk.dim(`      ${r.terms.map(t => `${t.note} +${t.value}`).join(' · ')}   ${r.file}:${r.line}`))
})
if (!out.ready.length) echo(chalk.dim(`  Nothing open${scope}.`))
echo('')

if (out.blocked.length) {
  echo(chalk.dim('  blocked, ranked the same way:'))
  for (const r of out.blocked) echo(`    ${blockedLine(r)}`)
  echo('')
}
```

## How a row is scored

Severity first, and four terms under it that break the ties severity leaves —
most open rows share one. **Cited**: how many live records (open rows, rulings,
proposals) cite the row, capped. **Blocks**: how many open rows declare
themselves `blocked by` it. **Touched**: whether a code file the row links is in
the working tree or the last few commits, which is the cheapest context to pick
up. **Reach**: how many workspace packages depend on the row's package, directly
or through another, read from their manifests — a defect in toolbelt or
litestone is met by every package above it. Reach is capped below one citation,
so it orders rows inside a tie and never past one. The weights are one table in
`core/next.js` and no flag moves them.

A row that cannot start until another closes says `blocked by FJS-###` in its
own text; it leaves the ranking and is listed under *blocked* until the blocker
closes. The *blocked* list is the same ranking, one line a row with its severity
and score, and `--limit` does not trim it. A row a headless session cannot finish says `by hand` as its own segment
of the links cell; it stays ranked, marked *(by hand)*, and `fix:loop` skips it. A row whose fix is the environment rather than the code says `env: <cause>` the same way — `port`, `shared db`, `stale process`, `timing`, `real machine` or `network` — and is marked *(env: cause)* and skipped too, because a headless session fixes the symptom and the row comes back.

`--by seam` reads the ranking the other way: every open row in scope —
blocked rows and owed rulings included — grouped by its `seam: <name>` segment,
the count first and the rows under it in rank order. Two spellings of one
Bridge index entry are one group. Eight rows on one seam is a design wrong
there rather than eight bugs, and that count is what decides whether a seam
gets a paper. `--limit` does not trim it. Proposals are not ranked here — `IDEAS/overview.md` ranks those.
