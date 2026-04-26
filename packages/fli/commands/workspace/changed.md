---
title: workspace:changed
description: List packages that have changed since their last git tag
alias: ws:changed
examples:
  - fli ws:changed
  - fli ws:changed --verbose
  - fli ws:changed --json
flags:
  verbose:
    char: v
    type: boolean
    description: Show changed files for each package
    defaultValue: false
  json:
    char: j
    type: boolean
    description: Output as JSON
    defaultValue: false
---

<script>
import { existsSync, readFileSync, readdirSync } from 'fs'
import { resolve } from 'path'

const getPackages = (wsRoot) => {
  const pkgsDir = resolve(wsRoot, 'packages')
  if (!existsSync(pkgsDir)) return []
  return readdirSync(pkgsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => {
      const dir = resolve(pkgsDir, d.name)
      try {
        const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'))
        return { dir, pkg, folder: d.name }
      } catch { return null }
    }).filter(Boolean)
}
</script>

Shows which packages have commits or file changes since their last release tag.
Run this before `fli ws:pub` to confirm what will be published.

```js
const wsRoot = await context.wsRoot()
if (!wsRoot) { log.error('No workspace path provided'); return }
const packages = getPackages(wsRoot)

if (!packages.length) {
  log.warn(`No packages found in ${wsRoot}/packages/`)
  return
}

const results = packages.map(({ dir, pkg }) => {
  const lastTag  = context.git.lastTag(dir)
  const affected = context.git.isAffected(dir)
  const dirty    = context.git.isDirty(dir)
  const commits  = lastTag ? context.git.log(lastTag, dir) : []
  const files    = dirty ? context.git.status(dir) : []
  return { name: pkg.name, version: pkg.version, lastTag, affected, dirty, commits, files }
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
  const tag = r.lastTag ? `since ${r.lastTag}` : 'no tags yet'
  echo(`  ${r.name}@${r.version}  (${tag})`)
  if (flag.verbose) {
    if (r.commits.length) {
      for (const c of r.commits) echo(`    ${c.hash}  ${c.subject}`)
    }
    if (r.files.length) {
      for (const f of r.files) echo(`    ${f}`)
    }
  }
}

if (clean.length) {
  echo('')
  for (const r of clean) echo(`  ${r.name}@${r.version}  ✓ clean`)
}
echo('')
```
