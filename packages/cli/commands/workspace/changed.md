---
title: workspace:changed
description: List packages that have changed since their last release tag
alias: ws:changed
examples:
  - fli ws:changed
  - fli ws:changed --verbose
  - fli ws:changed --json
flags:
  verbose:
    char: v
    type: boolean
    description: Show changed files and commits for each package
    defaultValue: false
  json:
    char: j
    type: boolean
    description: Output as JSON
    defaultValue: false
---

Shows which packages have commits or working-tree edits since their own release
tag (`<name>@<version>`, the scheme `ws:version` and `ws:pub` write).
Run this before `fli ws:pub` to confirm what will be published.

```js
const { wsRoot, packages } = await context.wsPackages()
if (!wsRoot) { log.error('No workspace path provided'); return }

if (!packages.length) {
  log.warn(`No packages found in ${wsRoot}/packages/`)
  return
}

const results = packages.map(({ dir, path, pkg }) => {
  const state = context.git.pkgState(pkg.name, dir)
  return { name: pkg.name, version: pkg.version, path, ...state }
})

if (flag.json) {
  echo(JSON.stringify(results, null, 2))
  return
}

const changed = results.filter(r => r.affected || r.dirty)
const clean   = results.filter(r => !r.affected && !r.dirty)

if (!changed.length) {
  log.success('All packages are up to date since their last tag')
  return
}

echo('')
echo(`  ${changed.length} changed  ·  ${clean.length} clean\n`)

for (const r of changed) {
  const tag = r.lastTag ? `since ${r.lastTag}` : 'never released'
  const n   = [
    r.commits.length ? `${r.commits.length} commit${r.commits.length === 1 ? '' : 's'}` : '',
    r.files.length   ? `${r.files.length} uncommitted` : '',
  ].filter(Boolean).join(', ')
  echo(`  ${r.name}@${r.version}  (${tag}${n ? ` — ${n}` : ''})`)
  if (flag.verbose) {
    for (const c of r.commits) echo(`    ${c.hash}  ${c.subject}`)
    for (const f of r.files)   echo(`    ${f}`)
  }
}

if (clean.length) {
  echo('')
  for (const r of clean) echo(`  ${r.name}@${r.version}  ✓ clean`)
}
echo('')
```
