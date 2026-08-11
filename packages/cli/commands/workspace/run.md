---
title: workspace:run
description: Run an npm script across all (or selected) workspace packages
alias: ws:run
examples:
  - fli ws-run build
  - fli ws-run test
  - fli ws-run build --filter fli --filter frontier-core
  - fli ws-run test --parallel
  - fli ws-run test --affected
  - fli ws-run lint --dry
args:
  -
    name: script
    description: npm script to run in each package
    required: true
flags:
  filter:
    char: f
    type: string
    description: Only run in packages matching this name (repeat for multiple)
    defaultValue: ''
  parallel:
    char: p
    type: boolean
    description: Run in all packages simultaneously instead of sequentially
    defaultValue: false
  affected:
    char: a
    type: boolean
    description: Only run in packages changed since their own release tag
    defaultValue: false
---

<script>
import { execSync } from 'child_process'

const hasScript = (pkg, name) => !!pkg.scripts?.[name]
</script>

```js
const { wsRoot, packages: all } = await context.wsPackages()
if (!wsRoot) { log.error('No workspace path provided'); return }
let packages = all

if (!packages.length) {
  log.error(`No packages found in ${wsRoot}/packages/`)
  return
}

// Apply filter
if (flag.filter) {
  const filters = Array.isArray(flag.filter) ? flag.filter : [flag.filter]
  packages = packages.filter(({ pkg, folder }) =>
    filters.some(f => pkg.name.includes(f) || folder.includes(f))
  )
  if (!packages.length) {
    log.error(`No packages matched filter: ${flag.filter}`)
    return
  }
}

// Apply --affected filter
if (flag.affected) {
  const before = packages.length
  packages = packages.filter(({ dir, pkg }) => context.git.pkgState(pkg.name, dir).affected)
  const skippedAffected = before - packages.length
  if (skippedAffected) log.info(`--affected: skipping ${skippedAffected} unchanged package(s)`)
  if (!packages.length) {
    log.info('No affected packages — nothing to run')
    return
  }
}

// Only run in packages that have the script
const targets = packages.filter(({ pkg }) => hasScript(pkg, arg.script))
const skipped = packages.filter(({ pkg }) => !hasScript(pkg, arg.script))

if (!targets.length) {
  log.warn(`No packages have script "${arg.script}"`)
  return
}

log.info(`Running "${arg.script}" in ${targets.length} package(s)${flag.parallel ? ' (parallel)' : ''}`)
if (skipped.length) log.info(`Skipping ${skipped.length} without the script`)

if (flag.dry) {
  for (const { pkg } of targets) log.dry(`Would run: ${pkg.name} → npm run ${arg.script}`)
  return
}

if (flag.parallel) {
  const results = await Promise.allSettled(
    targets.map(({ dir, pkg }) => new Promise((resolve, reject) => {
      try {
        execSync(`npm run ${arg.script}`, { cwd: dir, stdio: 'inherit' })
        resolve(pkg.name)
      } catch (err) { reject({ name: pkg.name, err }) }
    }))
  )
  for (const r of results) {
    if (r.status === 'fulfilled') log.success(`✓ ${r.value}`)
    else log.error(`✗ ${r.reason.name}: ${r.reason.err.message}`)
  }
} else {
  let failed = 0
  for (const { dir, pkg } of targets) {
    log.info(`  → ${pkg.name}`)
    try {
      execSync(`npm run ${arg.script}`, { cwd: dir, stdio: 'inherit' })
      log.success(`  ✓ ${pkg.name}`)
    } catch (err) {
      log.error(`  ✗ ${pkg.name}: ${err.message}`)
      failed++
    }
  }
  if (failed) log.error(`${failed} package(s) failed`)
  else log.success(`All done`)
}
```
