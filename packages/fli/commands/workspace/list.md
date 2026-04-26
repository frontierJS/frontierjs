---
title: workspace:list
description: List all packages in the workspace with versions and interdependencies
alias: ws:list
examples:
  - fli ws-list
  - fli ws-list --deps
  - fli ws-list --json
flags:
  deps:
    char: d
    type: boolean
    description: Show which packages depend on which
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
import { homedir } from 'os'


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
  log.warn(`No packages found in ${wsRoot}/packages/`)
  log.info('Run `fli ws-add <path>` to add a package')
  return
}

if (flag.json) {
  echo(JSON.stringify(packages.map(({ pkg, folder }) => ({
    name: pkg.name, version: pkg.version, folder,
    dependencies: pkg.dependencies || {},
    devDependencies: pkg.devDependencies || {}
  })), null, 2))
  return
}

// Build a set of all workspace package names for dep detection
const wsNames = new Set(packages.map(({ pkg }) => pkg.name))

echo(`\nWorkspace: ${wsRoot}`)
echo(`Packages:  ${packages.length}\n`)

for (const { pkg, folder, dir } of packages) {
  const branch = context.git.branch(dir)
  const branchStr = branch ? ` (${branch})` : ''
  echo(`  ${pkg.name}@${pkg.version}${branchStr}`)

  if (flag.deps) {
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
    const wsDeps = Object.entries(allDeps)
      .filter(([name]) => wsNames.has(name))
    const extDeps = Object.entries(allDeps)
      .filter(([name]) => !wsNames.has(name))

    if (wsDeps.length) {
      echo(`    workspace deps:`)
      for (const [name, ver] of wsDeps) echo(`      ${name}: ${ver}`)
    }
    if (extDeps.length) {
      echo(`    external deps: ${extDeps.length} packages`)
    }
    echo('')
  }
}
```
