---
title: workspace:graph
description: Show the dependency graph between workspace packages
alias: ws:graph
examples:
  - fli ws:graph
  - fli ws:graph --external
  - fli ws:graph --json
flags:
  external:
    char: e
    type: boolean
    description: Also show external (non-workspace) dependencies
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

Visualises which packages depend on which, so you know what order to build
and publish in. Workspace interdependencies are highlighted — external deps
are counted but hidden by default (use `--external` to show them).

```js
const wsRoot = await context.wsRoot()
if (!wsRoot) { log.error('No workspace path provided'); return }
const packages = getPackages(wsRoot)

if (!packages.length) {
  log.warn(`No packages found in ${wsRoot}/packages/`)
  return
}

const wsNames = new Set(packages.map(({ pkg }) => pkg.name))

// Build adjacency: name → { wsDeps, extDeps, dependents }
const graph = {}
for (const { pkg } of packages) {
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
  const wsDeps  = Object.keys(allDeps).filter(n => wsNames.has(n))
  const extDeps = Object.keys(allDeps).filter(n => !wsNames.has(n))
  graph[pkg.name] = { version: pkg.version, wsDeps, extDeps, dependents: [] }
}

// Build reverse edges
for (const [name, { wsDeps }] of Object.entries(graph)) {
  for (const dep of wsDeps) {
    if (graph[dep]) graph[dep].dependents.push(name)
  }
}

if (flag.json) {
  echo(JSON.stringify(graph, null, 2))
  return
}

// Topological sort — roots first (no ws deps)
const sorted = []
const visited = new Set()
const visit = (name) => {
  if (visited.has(name)) return
  visited.add(name)
  for (const dep of graph[name]?.wsDeps || []) visit(dep)
  sorted.push(name)
}
for (const name of Object.keys(graph)) visit(name)

echo('')
echo(`  Workspace: ${wsRoot}`)
echo(`  Packages:  ${packages.length}\n`)

for (const name of sorted) {
  const { version, wsDeps, extDeps, dependents } = graph[name]
  const hasWsDeps  = wsDeps.length > 0
  const hasDeps    = hasWsDeps || (flag.external && extDeps.length > 0)

  echo(`  ${name}@${version}`)

  if (hasWsDeps) {
    for (const dep of wsDeps) {
      echo(`    ← ${dep}  (workspace)`)
    }
  }

  if (flag.external && extDeps.length) {
    echo(`    ← ${extDeps.length} external dep(s)`)
  }

  if (dependents.length) {
    echo(`    → used by: ${dependents.join(', ')}`)
  }

  if (!hasWsDeps && !dependents.length) {
    echo(`    (standalone)`)
  }
}
echo('')

// Detect cycles
const cycles = []
const checkCycle = (name, path = []) => {
  if (path.includes(name)) { cycles.push([...path, name]); return }
  for (const dep of graph[name]?.wsDeps || []) checkCycle(dep, [...path, name])
}
for (const name of Object.keys(graph)) checkCycle(name)

if (cycles.length) {
  log.warn(`Circular dependencies detected:`)
  for (const cycle of cycles) echo(`  ${cycle.join(' → ')}`)
}
```
