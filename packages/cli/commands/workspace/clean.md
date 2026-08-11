---
title: workspace:clean
description: Delete build artifacts across all workspace packages
alias: ws:clean
examples:
  - fli ws:clean
  - fli ws:clean --deps
  - fli ws:clean --filter fli
  - fli ws:clean --dry
flags:
  deps:
    char: d
    type: boolean
    description: Also delete node_modules in each package
    defaultValue: false
  filter:
    char: f
    type: string
    description: Only clean packages matching this name
    defaultValue: ''
---

<script>
import { existsSync, rmSync } from 'fs'
import { resolve } from 'path'

const ARTIFACT_DIRS = ['dist', '.turbo', 'build', '.next', 'out']
</script>

Removes `dist/`, `.turbo/`, `build/` and other build artifacts from
every package. Pass `--deps` to also wipe `node_modules` (implies `bun install`
after). Safe to run anytime — just re-run `ws:run build` to rebuild.

```js
const { wsRoot, packages: all } = await context.wsPackages()
if (!wsRoot) { log.error('No workspace path provided'); return }
let packages = all

if (!packages.length) {
  log.warn(`No packages found in ${wsRoot}/packages/`)
  return
}

if (flag.filter) {
  const filters = Array.isArray(flag.filter) ? flag.filter : [flag.filter]
  packages = packages.filter(({ pkg, folder }) =>
    filters.some(f => pkg.name.includes(f) || folder.includes(f))
  )
}

const targets = [...ARTIFACT_DIRS]
if (flag.deps) targets.push('node_modules')

let totalRemoved = 0

for (const { dir, pkg } of packages) {
  const found = targets.filter(t => existsSync(resolve(dir, t)))
  if (!found.length) continue

  log.info(`  ${pkg.name}`)
  for (const t of found) {
    const full = resolve(dir, t)
    if (flag.dry) {
      log.dry(`    rm -rf ${full}`)
    } else {
      rmSync(full, { recursive: true, force: true })
      log.info(`    removed  ${t}/`)
      totalRemoved++
    }
  }
}

if (flag.dry) return

if (!totalRemoved) {
  log.info('Nothing to clean — all packages already clean')
} else {
  log.success(`Cleaned ${totalRemoved} director${totalRemoved === 1 ? 'y' : 'ies'} across ${packages.length} package(s)`)
  if (flag.deps) log.info('Run `fli ws:install` to restore node_modules')
}
```
