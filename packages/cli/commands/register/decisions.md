---
title: register:decisions
description: What is waiting on the owner — every open question the registers hold, and which can be answered now
alias: decisions
examples:
  - fli decisions
  - fli decisions --open
  - fli decisions --json
flags:
  open:
    char: o
    type: boolean
    description: Also list the questions that have no options written yet
    defaultValue: false
  json:
    char: j
    type: boolean
    description: Emit every question as JSON
    defaultValue: false
---

```js
const { openDecisions, readDecisions } = await import(resolve(global.fliRoot, 'core/decisions.js'))

const { findRegisterRoot } = await import(resolve(global.fliRoot, 'core/registers.js'))

// The nearest package.json declaring `registers`, so a run from inside a
// package or a surface means the project's registers.
const root = findRegisterRoot(process.cwd()) ?? $.paths.root

if (flag.json) {
  echo(JSON.stringify(readDecisions(root), null, 2))
  return
}

const { decidable, settled, open, ruled } = openDecisions(root)

echo('')
echo(`  ${chalk.bold('Decisions')}  ${chalk.dim(`·  ${decidable.length} to pick  ·  ${settled.length} settled by a ruling  ·  ${open.length} without options  ·  ${ruled} ruled`)}\n`)

for (const q of settled) {
  echo(`  ${chalk.bold(chalk.green(q.id))}`)
  echo(`    ${q.question}   ${chalk.dim(`${q.file}:${q.line}`)}`)
  echo(`    ${chalk.dim(`settled by ${q.by}: ${q.recommend.why}`)}`)
  echo('')
}

for (const q of decidable) {
  echo(`  ${chalk.bold(chalk.yellow(q.id))}`)
  echo(`    ${q.question}   ${chalk.dim(`${q.file}:${q.line}`)}`)
  for (const o of q.options) {
    const picked = q.recommend?.letter === o.letter
    echo(`    ${picked ? chalk.green('★') : ' '} ${chalk.bold(o.letter)} — ${o.text}`)
  }
  if (q.recommend?.why) echo(chalk.dim(`      why ${q.recommend.qualifier ?? q.recommend.letter}: ${q.recommend.why}`))
  echo('')
}

if (!decidable.length && !settled.length) {
  echo(chalk.dim('  Nothing can be picked yet: no open question carries lettered options.'))
  echo('')
}

if (flag.open) {
  const byFile = new Map()
  for (const q of open) (byFile.get(q.file) ?? byFile.set(q.file, []).get(q.file)).push(q)
  for (const [file, qs] of byFile) {
    echo(`  ${chalk.cyan(file)}`)
    for (const q of qs) echo(`    ${chalk.dim(String(q.line).padStart(5))}  ${q.question}`)
  }
  echo('')
} else if (open.length) {
  echo(chalk.dim(`  ${open.length} more have no options yet — --open lists them.`))
  echo('')
}

if (decidable.length || settled.length) {
  echo(`  ${chalk.dim('Walk them one key each:')} ${chalk.cyan('fli decide')}`)
  if (decidable.length) echo(`  ${chalk.dim('Pick one:')} ${chalk.cyan('fli decide <id> <letter> --section "<DECISIONS.md section>" [--why "…"]')}`)
  if (settled.length)   echo(`  ${chalk.dim('Confirm one:')} ${chalk.cyan('fli decide <id> --by <ruling>')}`)
  echo('')
}
```

## What makes a question decidable

A question lives where it was argued — an IDEAS paper's `## Open questions`,
or a row of `ISSUES.md` § Needs a decision. It becomes something the owner can
answer on sight once its bullet carries lettered options and a recommendation:
indented sub-bullets under the question, each opening on a bold letter — `**A** —
omit them`, `**B** — expose them` — and one opening on `**Recommend A** —` with
the reason after the dash. The bold may say more than the letter (`**Recommend
A, same-row zone only**`); it must START with one, and `register:check` fails a
`**Recommend` line that does not (`unread-recommendation`).

Writing those lines is the work that turns an open question into a
decision; an issue row's cell cannot hold them, so its options go in the paper
its Detail links. `fli register:decide` answers one, and `fli gui` shows the
same queue with the options as buttons.

A question whose recommendation names a live ruling as already answering it is
listed as **settled**: `fli decide <id> --by <ruling>` strikes it citing that
ruling and mints no new one. `fli decide` with no id walks both kinds.
