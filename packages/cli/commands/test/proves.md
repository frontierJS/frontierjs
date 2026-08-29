---
title: test:proves
description: Which drive proves the change you just made
alias: proves
examples:
  - fli proves
  - fli proves --from main
  - fli proves --json
flags:
  from:
    char: f
    type: string
    description: Compare against this ref instead of the working tree
  json:
    type: boolean
    description: Answer a machine
    defaultValue: false
---

<script>
import { execSync } from 'child_process'
</script>

Reads `CLAUDE.md` § *Which drive proves a change* and matches it against what
you have actually changed.

The table is thirty rows of knowledge that was paid for one defect at a time,
and until this command nothing read it. Half of those rows are not import edges
and never could be — *a `@@gate` on a model a SCREEN reads → `verify:account`*
is a statement about what a drive can SEE — so this is a reader for a table a
person wrote, not a build graph.

**It does not replace the package's own suite.** That is still the first thing;
this answers *and then which drive*.

```js
// `wsRoot()` is ASYNC, and an unawaited one is a Promise that reaches
// `execSync` as a cwd — which fails with a message about a type, three steps
// from the cause. The workspace, because the proof table is at its root.
const root = (await context.wsRoot?.()) ?? context.paths.root

// `resolve` is already in scope — the compiled shim imports `zx/globals`.
const { provesFor } = await import(resolve(global.fliRoot, 'core/proofs.js'))
const { runnables } = await import(resolve(global.fliRoot, 'core/runnables.js'))

// The working tree by default, a ref when one is named. `--from main` is what a
// branch asks; the bare form is what somebody about to commit asks.
const against = flag.from ? `${flag.from}...` : 'HEAD'
const git = (argv) => {
  try { return execSync(`git ${argv}`, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }) }
  catch { return '' }
}

const files = git(`diff --name-only ${against}`).trim().split('\n').filter(Boolean)
if (!files.length) {
  log.info(flag.from ? `nothing changed against ${flag.from}` : 'nothing changed in the working tree')
  if (flag.json) console.log(JSON.stringify({ files: [], rows: [] }, null, 2))
  return
}

// The diff CONTENT, for the symbol tier. Without it a row that names
// `announceDataWrites` can only match by the package it lives in.
const diff = git(`diff -U0 ${against}`)
const rows = provesFor(root, { files, diff, rows: runnables(root) })

if (flag.json) {
  console.log(JSON.stringify({ files, rows }, null, 2))
  return
}

log.info(`${files.length} file(s) changed`)

if (!rows.length) {
  log.warn('no row of the proof table matches this change.')
  log.info('That is a table that is behind, not a change that is unproven — run the package\'s own suite.')
  return
}

// The tier travels with the answer, so a weak match reads as a weak match. A
// package-only match means *something in here changed and this row is about
// here*, which is true of four rows at once for sierra.
const TIER = {
  path:    'names the file',
  area:    'names the area',
  symbol:  'names a symbol in the diff',
  package: 'names the package',
}

console.log('')
for (const row of rows) {
  console.log(`  ${chalk.bold(row.changed)}`)
  console.log(`  ${chalk.dim(`${TIER[row.match.tier]} — ${row.match.on.slice(0, 3).join(', ')}`)}`)
  for (const t of row.targets) {
    const where = t.dir ?? t.where
    if (t.kind === 'file')  { console.log(`    ${chalk.dim('read')}  ${where}/${t.name}`); continue }
    if (t.kind === 'unknown') { console.log(`    ${chalk.red('gone')}  ${where}: ${t.name}`); continue }
    console.log(`    ${chalk.green('run')}   cd ${where} && ${t.command}`)
  }
  console.log('')
}

log.info('the package\'s own suite first — this is what to run after it')
```
