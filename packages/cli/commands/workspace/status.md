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
const { wsRoot, packages } = await context.wsPackages()
if (!wsRoot) { log.error('No workspace path provided'); return }

if (!packages.length) {
  log.warn('No packages found — run `fli ws-init` and `fli ws-add`')
  return
}

const repo = context.wsRepo(packages)

echo(`\nWorkspace: ${wsRoot}`)
if (repo) {
  const branch = context.git.branch(repo)
  const ahead  = context.git.ahead(repo)
  const behind = context.git.behind(repo)
  echo(`Repo:      one at ${repo}`)
  echo(`Branch:    ${branch}  ↑${ahead} ↓${behind}\n`)
} else {
  echo(`Repo:      one per package\n`)
}

let anyDirty = false

for (const { dir, pkg } of packages) {
  const lines = context.git.pkgState(pkg.name, dir).files
  const dirty = lines.length > 0
  if (dirty) anyDirty = true

  // Per-package branch and sync counts only mean something when the package
  // IS its own repo.
  const head = repo
    ? `${pkg.name}@${pkg.version}`
    : `${pkg.name}@${pkg.version}  ${context.git.branch(dir)} ↑${context.git.ahead(dir)} ↓${context.git.behind(dir)}`

  if (flag.short) {
    echo(`  ${head}${dirty ? `  [${lines.length} changed]` : '  [clean]'}`)
  } else {
    echo(`  ${head}`)
    if (dirty) for (const line of lines) echo(`    ${line}`)
    else echo(`    nothing to commit`)
    echo('')
  }
}

if (!anyDirty) log.success('All packages clean')
```
