---
title: workspace:add
description: Add an existing package repo into the workspace
alias: ws:add
examples:
  - fli ws-add ~/projects/fli
  - fli ws-add ~/projects/frontier-core --scope @frontierjs
  - fli ws-add ~/projects/ksite --copy
  - fli ws-add ~/projects/fli --dry
args:
  -
    name: path
    description: Path to the existing package directory to add
    required: true
flags:
  scope:
    char: s
    type: string
    description: npm scope to apply to the package name (e.g. @frontierjs)
    defaultValue: '@frontierjs'
  copy:
    type: boolean
    description: Copy the package instead of moving it (keeps the original in place)
    defaultValue: false
---

<script>
import { existsSync, readFileSync, writeFileSync, cpSync, renameSync } from 'fs'
import { resolve, basename } from 'path'
import { homedir } from 'os'
import { execSync } from 'child_process'


const getPkg = (dir) => {
  try { return JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')) }
  catch { return null }
}

const setPkg = (dir, pkg) =>
  writeFileSync(resolve(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8')
</script>

Moves (or copies) an existing package into `$WORKSPACE_DIR/packages/`
and applies the `@frontierjs` scope to its name if it isn't already scoped.

After adding, run `bun install` at the workspace root to wire everything up.

```js
const wsRoot = await context.wsRoot()
if (!wsRoot) { log.error('No workspace path provided'); return }
const srcPath  = resolve(arg.path)
const pkgName  = basename(srcPath)
const destPath = resolve(wsRoot, 'packages', pkgName)

// ─── Validate ────────────────────────────────────────────────────────────────
if (!existsSync(wsRoot)) {
  log.error(`Workspace not found at ${wsRoot}`)
  log.info('Run `fli ws-init` first')
  return
}
if (!existsSync(srcPath)) {
  log.error(`Package not found: ${srcPath}`)
  return
}
const pkg = getPkg(srcPath)
if (!pkg) {
  log.error(`No package.json found in ${srcPath}`)
  return
}
if (existsSync(destPath)) {
  log.warn(`${pkgName} already exists in workspace at ${destPath}`)
  return
}

// ─── Scope the package name ───────────────────────────────────────────────────
const oldName = pkg.name
const newName = pkg.name.startsWith('@')
  ? pkg.name
  : `${flag.scope}/${pkg.name}`

const action = flag.copy ? 'copy' : 'move'
log.info(`${action}: ${srcPath} → ${destPath}`)
if (oldName !== newName) log.info(`rename: ${oldName} → ${newName}`)

if (flag.dry) {
  log.dry(`Would ${action} package into workspace`)
  log.dry(`Would update name: ${oldName} → ${newName}`)
  log.dry('Would run: bun install at workspace root')
  return
}

// ─── Move or copy ─────────────────────────────────────────────────────────────
if (flag.copy) {
  cpSync(srcPath, destPath, { recursive: true })
} else {
  renameSync(srcPath, destPath)
}

// ─── Update package name ──────────────────────────────────────────────────────
if (oldName !== newName) {
  pkg.name = newName
  setPkg(destPath, pkg)
}

log.success(`Added ${newName} to workspace`)
echo('')
echo(`Next: cd ${wsRoot} && bun install`)
```
