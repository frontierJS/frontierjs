---
title: workspace:link
description: Declare one workspace package as a dependency of another
alias: ws:link
examples:
  - fli ws-link frontier-core fli
  - fli ws-link frontier-core my-app --dev
  - fli ws-link frontier-core fli --dry
args:
  -
    name: from
    description: Package to add as a dependency (the one being depended on)
    required: true
  -
    name: to
    description: Package that will depend on it (the consumer)
    required: true
flags:
  dev:
    type: boolean
    description: Add as a devDependency instead of dependency
    defaultValue: false
---

<script>
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'


const getPkg = (dir) => {
  try { return JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')) }
  catch { return null }
}
const setPkg = (dir, pkg) =>
  writeFileSync(resolve(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8')

const findPkg = (wsRoot, name) => {
  // Accept bare name (fli), scoped name (@frontierjs/fli), or folder name
  const pkgsDir = resolve(wsRoot, 'packages')
  const { readdirSync } = require('fs')
  try {
    return readdirSync(pkgsDir).map(d => {
      const dir = resolve(pkgsDir, d)
      const pkg = getPkg(dir)
      return pkg ? { dir, pkg } : null
    }).filter(Boolean).find(({ dir, pkg }) =>
      pkg.name === name ||
      pkg.name === `@frontierjs/${name}` ||
      dir.endsWith(`/${name}`)
    )
  } catch { return null }
}
</script>

Adds `workspace:*` to the `dependencies` (or `devDependencies`) of one package,
pointing to another package in the same workspace.

After running, do `bun install` at the workspace root.

```js
const wsRoot = await context.wsRoot()
if (!wsRoot) { log.error('No workspace path provided'); return }

const fromEntry = findPkg(wsRoot, arg.from)
const toEntry   = findPkg(wsRoot, arg.to)

if (!fromEntry) { log.error(`Package not found in workspace: ${arg.from}`); return }
if (!toEntry)   { log.error(`Package not found in workspace: ${arg.to}`);   return }

const depKey = flag.dev ? 'devDependencies' : 'dependencies'
const { pkg: fromPkg } = fromEntry
const { dir: toDir, pkg: toPkg } = toEntry

// Check if already linked
const existing = toPkg.dependencies?.[fromPkg.name] || toPkg.devDependencies?.[fromPkg.name]
if (existing) {
  log.warn(`${toPkg.name} already has ${fromPkg.name}: ${existing}`)
  return
}

log.info(`Linking: ${fromPkg.name} → ${toPkg.name} (${depKey})`)
log.info(`  ${toPkg.name}.${depKey}.${fromPkg.name} = "workspace:*"`)

if (flag.dry) {
  log.dry('Would update package.json and run bun install')
  return
}

toPkg[depKey] ??= {}
toPkg[depKey][fromPkg.name] = 'workspace:*'

// Keep deps sorted
toPkg[depKey] = Object.fromEntries(Object.entries(toPkg[depKey]).sort())

setPkg(toDir, toPkg)
log.success(`Updated ${toPkg.name}/package.json`)

echo('')
echo(`Run: cd ${wsRoot} && bun install`)
```
