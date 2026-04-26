---
title: workspace:exec
description: Run a shell command in every package directory
alias: ws:exec
examples:
  - fli ws:exec "rm -rf dist"
  - fli ws:exec "git fetch"
  - fli ws:exec "ls -la" --filter fli
  - fli ws:exec "cat package.json" --parallel
  - fli ws:exec "rm -rf dist" --dry
args:
  -
    name: command
    description: Shell command to run in each package directory
    required: true
    variadic: true
flags:
  filter:
    char: f
    type: string
    description: Only run in packages matching this name
    defaultValue: ''
  parallel:
    char: p
    type: boolean
    description: Run in all packages simultaneously
    defaultValue: false
---

<script>
import { existsSync, readFileSync, readdirSync } from 'fs'
import { resolve } from 'path'
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
      } catch { return { dir, pkg: { name: d.name }, folder: d.name } }
    })
}
</script>

Runs an arbitrary shell command in every package directory.
Unlike `ws:run`, this doesn't require a `package.json` script — any shell
command works. Useful for cleanup, git operations, or one-off tasks.

```js
const wsRoot = await context.wsRoot()
if (!wsRoot) { log.error('No workspace path provided'); return }
let packages = getPackages(wsRoot)

if (!packages.length) {
  log.warn(`No packages found in ${wsRoot}/packages/`)
  return
}

if (flag.filter) {
  const filters = Array.isArray(flag.filter) ? flag.filter : [flag.filter]
  packages = packages.filter(({ pkg, folder }) =>
    filters.some(f => pkg.name?.includes(f) || folder.includes(f))
  )
  if (!packages.length) {
    log.error(`No packages matched filter: ${flag.filter}`)
    return
  }
}

const cmd = arg.command

log.info(`Executing in ${packages.length} package(s): ${cmd}`)
if (flag.dry) {
  for (const { pkg, dir } of packages) log.dry(`${pkg.name}  →  ${cmd}  (${dir})`)
  return
}

if (flag.parallel) {
  const results = await Promise.allSettled(
    packages.map(({ dir, pkg }) => new Promise((res, rej) => {
      try { execSync(cmd, { cwd: dir, stdio: 'inherit' }); res(pkg.name) }
      catch (err) { rej({ name: pkg.name, err }) }
    }))
  )
  for (const r of results) {
    if (r.status === 'fulfilled') log.success(r.value)
    else log.error(`${r.reason.name}: ${r.reason.err.message}`)
  }
} else {
  let failed = 0
  for (const { dir, pkg } of packages) {
    log.info(`  → ${pkg.name}`)
    try {
      execSync(cmd, { cwd: dir, stdio: 'inherit' })
      log.success(`  ✓ ${pkg.name}`)
    } catch (err) {
      log.error(`  ✗ ${pkg.name}: ${err.message}`)
      failed++
    }
  }
  if (failed) log.error(`${failed} package(s) failed`)
  else log.success('Done')
}
```
