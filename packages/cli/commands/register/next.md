---
title: register:next
description: What to work on next — the open register ranked, every row printed with the terms that scored it
alias: next
examples:
  - fli next
  - fli next --pkg junction
  - fli next --limit 25
  - fli next --json
flags:
  pkg:
    char: p
    type: string
    description: Only rows filed against this package
  limit:
    char: l
    type: string
    description: How many ready rows to print
    defaultValue: '10'
  json:
    char: j
    type: boolean
    description: Emit the whole ranking as JSON
    defaultValue: false
---

```js
const { rankNext } = await import(resolve(global.fliRoot, 'core/next.js'))

const { findRegisterRoot } = await import(resolve(global.fliRoot, 'core/registers.js'))

// The nearest package.json declaring `registers`, so a run from inside a
// package or a surface means the project's registers.
const root = findRegisterRoot(process.cwd()) ?? $.paths.root
const out  = rankNext(root, { pkg: flag.pkg || null })

if (flag.json) {
  echo(JSON.stringify(out, null, 2))
  return
}

const limit = Math.max(1, Number.parseInt(flag.limit ?? '10', 10) || 10)
const scope = flag.pkg ? ` in ${flag.pkg}` : ''

echo('')
echo(`  fli register:next — ${out.ready.length} ready${scope} · ${out.blocked.length} blocked · ${out.decide.decidable} to decide`)
echo('')

if (out.decide.decidable) {
  echo(`  decide first: ${out.decide.decidable} question(s) have options written — fli decisions`)
  echo('')
}
if (out.decide.framed.length) {
  echo('  waiting on a ruling, options written — fli decide:')
  for (const r of out.decide.framed) echo(`    ${r.id}  ${r.title.slice(0, 90)}`)
  echo('')
}
if (out.decide.rows.length) {
  echo('  waiting on a ruling, with no options written yet — /frame-next:')
  for (const r of out.decide.rows) echo(`    ${r.id}  ${r.title.slice(0, 90)}`)
  echo('')
}

out.ready.slice(0, limit).forEach((r, i) => {
  const flag_ = (r.probeFirst ? '  (stale? — probe before acting)' : '') + (r.byHand ? '  (by hand)' : '')
  echo(`  ${String(i + 1).padStart(2)}. ${r.id.padEnd(9)} ${String(r.score).padStart(3)}  ${r.pkg.join(' · ')}${flag_}`)
  echo(`      ${r.title.slice(0, 110)}`)
  echo(`      ${r.terms.map(t => `${t.note} +${t.value}`).join(' · ')}   ${r.file}:${r.line}`)
})
if (!out.ready.length) echo(`  Nothing open${scope}.`)
echo('')

if (out.blocked.length) {
  echo('  blocked:')
  for (const r of out.blocked) echo(`    ${r.id}  waits on ${r.blockedBy.join(', ')} — ${r.title.slice(0, 80)}`)
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
closes. A row a headless session cannot finish says `by hand` as its own segment
of the links cell; it stays ranked, marked *(by hand)*, and `fix:loop` skips it. Proposals are not ranked here — `IDEAS/overview.md` ranks those.
