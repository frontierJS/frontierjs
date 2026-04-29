---
title: fli:update
description: Pull latest fli from the repo, install deps, and link the global binary
alias: update
examples:
  - fli update
  - fli update --dry
  - fli update --no-link
  - fli update --no-install
  - fli update --branch main
flags:
  branch:
    description: Specific branch to pull (defaults to current)
  link:
    type: boolean
    description: Run bun link after install (use --no-link to skip)
    defaultValue: true
  install:
    type: boolean
    description: Run bun install after pull (use --no-install to skip)
    defaultValue: true
---

<script>
import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { resolve, dirname } from 'path'

// Walk up from `start` looking for a .git directory. Returns the directory
// containing .git, or null if we hit the filesystem root without finding one.
const findRepoRoot = (start) => {
  let dir = start
  while (true) {
    if (existsSync(resolve(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// Check whether `fli` is already linked globally. `which fli` returns the
// path; if the binary doesn't exist, it errors out and we treat that as
// "not linked yet".
const isLinked = () => {
  try {
    execSync('which fli', { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}
</script>

Update fli to the latest version from the repo. Designed for the FJS
monorepo layout where fli lives at `packages/cli` — finds the repo root,
pulls there, installs deps from the repo root (so workspace hoisting works),
then re-links the global binary from fli's own package directory.

```js
const fliRoot = global.fliRoot
const repoRoot = findRepoRoot(fliRoot)

if (!repoRoot) {
  log.error(`No git repo found above ${fliRoot}`)
  log.info('fli:update needs fli to live inside a git checkout.')
  return
}

// Show what we're about to do
log.info(`fli root:   ${fliRoot}`)
log.info(`repo root:  ${repoRoot}`)

// Pre-flight: warn on dirty fli source
const dirtyFiles = context.git.status(fliRoot)
if (dirtyFiles.length > 0) {
  log.warn(`uncommitted changes in fli source (${dirtyFiles.length} file(s)):`)
  dirtyFiles.slice(0, 5).forEach((line) => log.warn(`  ${line}`))
  if (dirtyFiles.length > 5) log.warn(`  ... and ${dirtyFiles.length - 5} more`)
  log.warn('git pull may fail or create merge conflicts — commit or stash first if so')
}

// Determine target branch
const currentBranch = context.git.branch(repoRoot)
const targetBranch = flag.branch || currentBranch

if (flag.branch && flag.branch !== currentBranch) {
  log.info(`switching from ${currentBranch} → ${targetBranch}`)
  await context.exec({
    command: `cd ${repoRoot} && git checkout ${targetBranch}`,
    dry: flag.dry
  })
} else {
  log.info(`branch:     ${currentBranch || '(detached)'}`)
}

// Pull
log.info('pulling latest...')
await context.exec({
  command: `cd ${repoRoot} && git pull`,
  dry: flag.dry
})

// Install — at the repo root so workspace hoisting works in a monorepo
if (flag.install === false) {
  log.info('skipping bun install (--no-install)')
} else {
  log.info('installing deps...')
  await context.exec({
    command: `cd ${repoRoot} && bun install`,
    dry: flag.dry
  })
}

// Link — at fliRoot, where the bin field lives. Idempotent.
const wasLinked = isLinked()
if (flag.link === false) {
  log.info('skipping bun link (--no-link)')
} else if (wasLinked) {
  // Already linked — Bun's link is a symlink, code changes are already live.
  // Re-running bun link would be a no-op but emits noise; skip it.
  log.info('fli already linked globally — code changes are live')
} else {
  log.info('linking fli globally...')
  await context.exec({
    command: `cd ${fliRoot} && bun link`,
    dry: flag.dry
  })
}

if (!flag.dry) {
  log.success('fli updated')
  if (!wasLinked && flag.link !== false) {
    log.info('run `fli list` to see all commands')
  }
}
```
