---
title: workspace:status
description: Show git status per package
alias: ws:status
examples:
  - fli ws-status
  - fli ws-status --short
flags:
  short:
    char: s
    type: boolean
    description: Show one-line summary per package (changed file count only)
    defaultValue: false
---

Working-tree state, scoped to each package's own files.

In a single-repo monorepo the branch and the ahead/behind counts belong to the
whole repo — they are the same number on every row and are printed once at the
top rather than repeated sixteen times as if each package had its own.

```js
const { wsRoot, packages } = await $.wsPackages()
if (!wsRoot) { log.error('No workspace path provided'); return }

if (!packages.length) {
  log.warn('No packages found — run `fli ws:init` and `fli ws:add`')
  return
}

const repo = $.wsRepo(packages)

echo(`\n  ${chalk.bold('Workspace')}  ${chalk.dim(wsRoot)}`)
if (repo) {
  const branch = $.git.branch(repo)
  const ahead  = $.git.ahead(repo)
  const behind = $.git.behind(repo)
  echo(`  ${chalk.dim('Repo')}       one at ${chalk.dim(repo)}`)
  echo(`  ${chalk.dim('Branch')}     ${chalk.cyan(branch)}  ${chalk.dim(`↑${ahead} ↓${behind}`)}\n`)
} else {
  echo(`  ${chalk.dim('Repo')}       one per package\n`)
}

let anyDirty = false

for (const { dir, pkg } of packages) {
  const lines = $.git.pkgState(pkg.name, dir).files
  const dirty = lines.length > 0
  if (dirty) anyDirty = true

  // Per-package branch and sync counts only mean something when the package
  // IS its own repo.
  const name = `${chalk.bold(pkg.name)}${chalk.dim(`@${pkg.version}`)}`
  const head = repo
    ? name
    : `${name}  ${chalk.cyan($.git.branch(dir))} ${chalk.dim(`↑${$.git.ahead(dir)} ↓${$.git.behind(dir)}`)}`

  if (flag.short) {
    echo(`  ${head}${dirty ? chalk.yellow(`  ${lines.length} changed`) : chalk.green('  ✓ clean')}`)
  } else {
    echo(`  ${head}`)
    if (dirty) for (const line of lines) echo(`    ${line}`)
    else echo(`    ${chalk.dim('nothing to commit')}`)
    echo('')
  }
}

if (!anyDirty) log.success('All packages clean')
```
