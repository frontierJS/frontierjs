---
title: workspace:status
description: Show git status across all workspace packages
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

<script>
import { existsSync, readFileSync, readdirSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'
import { execSync } from 'child_process'


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

// git helpers available via context.git
</script>

```js
const wsRoot = await context.wsRoot()
if (!wsRoot) { log.error('No workspace path provided'); return }
const packages = getPackages(wsRoot)

if (!packages.length) {
  log.warn('No packages found — run `fli ws-init` and `fli ws-add`')
  return
}

echo(`\nWorkspace: ${wsRoot}\n`)

let anyDirty = false

for (const { dir, pkg } of packages) {
  const branch  = context.git.branch(dir)
  const lines   = context.git.status(dir)
  const status  = lines.join('\n')
  const ahead   = context.git.ahead(dir)
  const behind  = context.git.behind(dir)
  const dirty   = lines.length > 0
  const syncStr = ahead || behind
    ? ` ↑${ahead} ↓${behind}`
    : ' ✓'

  if (dirty) anyDirty = true

  if (flag.short) {
    const dirtyStr = dirty ? ` [${lines.length} changed]` : ' [clean]'
    echo(`  ${pkg.name}@${pkg.version}  ${branch}${syncStr}${dirtyStr}`)
  } else {
    echo(`  ${pkg.name}@${pkg.version}  (${branch}${syncStr})`)
    if (dirty) {
      for (const line of lines) echo(`    ${line}`)
    } else {
      echo(`    nothing to commit`)
    }
    echo('')
  }
}

if (!anyDirty) log.success('All packages clean')
```
