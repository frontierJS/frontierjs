---
title: fli:update
description: Bring this fli up to date — from npm when it was installed, from the checkout when it was linked
alias: update
examples:
  - fli update
  - fli update --dry
  - fli update --no-link
  - fli update --no-install
  - fli update --branch main
flags:
  branch:
    description: Specific branch to pull (defaults to current) — a linked checkout only
  link:
    type: boolean
    description: Run bun link after install (use --no-link to skip) — a linked checkout only
    defaultValue: true
  install:
    type: boolean
    description: Run bun install after pull (use --no-install to skip) — a linked checkout only
    defaultValue: true
---

<script>
import { execSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
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

// Which package manager put a GLOBAL fli on this machine, read off where it
// sits. Derived rather than asked, because the person running this is the one
// least likely to remember — and answered as `null` rather than guessed: an
// upgrade run through the wrong manager installs a second copy and leaves the
// one on PATH exactly where it was.
const globalManagerFor = (dir) => {
  const path = dir.replace(/\\/g, '/')
  if (path.includes('/.bun/install/global/')) return 'bun'
  if (/\/lib\/node_modules\//.test(path))    return 'npm'
  return null
}

// What this build of fli calls itself. Read after an upgrade too — the install
// path does not move, so the same file answers before and after, and a version
// that did not change is the whole verdict on whether anything happened.
const installedVersion = (dir) => {
  try { return JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')).version || '' }
  catch { return '' }
}
</script>

Bring this fli up to date. There are two ways one gets onto a machine and the
command reads which it is rather than being told: **a linked checkout**, where
fli lives inside a git repo (the FJS monorepo, at `packages/cli`) — pull at the
repo root, install there so workspace hoisting works, and re-link the global
binary from fli's own directory; or **an install from npm**, where the upgrade
is the manager's and the only question is which manager put it there, answered
from where it sits.

Neither one touches an APP's `@frontierjs/*` dependencies. That is `bun update`
in the app, and it is a different decision — the framework version an app builds
against is committed in its lockfile, where the version of the tool you type is
not.

```js
const fliRoot = global.fliRoot
const repoRoot = findRepoRoot(fliRoot)

// ─── installed from npm ───────────────────────────────────────────────────────
// No git above fli means nobody linked it: this copy came from the registry and
// the upgrade belongs to whichever manager installed it.
if (!repoRoot) {
  const manager = globalManagerFor(fliRoot)
  const before  = installedVersion(fliRoot)

  if (!manager) {
    log.error(`Not a git checkout, and not a global install this recognizes: ${fliRoot}`)
    log.info('Upgrade it with whichever installed it:')
    log.info('  bun add -g @frontierjs/cli@latest')
    log.info('  npm install -g @frontierjs/cli@latest')
    return
  }

  const command = manager === 'bun'
    ? 'bun add -g @frontierjs/cli@latest'
    : 'npm install -g @frontierjs/cli@latest'

  log.info(`version:   ${before || '(unknown)'} at ${fliRoot}`)
  log.info(`installed by ${manager} — upgrading from npm`)
  await $.exec({ command, dry: flag.dry })

  if (flag.dry) return

  // The install path does not move, so the same package.json answers again.
  // Said either way round: an upgrade that changed nothing must not read as one
  // that worked.
  const after = installedVersion(fliRoot)
  if (after && after !== before) log.success(`fli ${before || '?'} → ${after}`)
  else log.info(`Already the latest — still ${after || before || '(unknown)'}`)
  return
}

// Show what we're about to do
log.info(`fli root:   ${fliRoot}`)
log.info(`repo root:  ${repoRoot}`)

// Pre-flight: warn on dirty fli source
const dirtyFiles = $.git.status(fliRoot)
if (dirtyFiles.length > 0) {
  log.warn(`uncommitted changes in fli source (${dirtyFiles.length} file(s)):`)
  dirtyFiles.slice(0, 5).forEach((line) => log.warn(`  ${line}`))
  if (dirtyFiles.length > 5) log.warn(`  ... and ${dirtyFiles.length - 5} more`)
  log.warn('git pull may fail or create merge conflicts — commit or stash first if so')
}

// Determine target branch
const currentBranch = $.git.branch(repoRoot)
const targetBranch = flag.branch || currentBranch

if (flag.branch && flag.branch !== currentBranch) {
  log.info(`switching from ${currentBranch} → ${targetBranch}`)
  await $.exec({
    command: `cd ${repoRoot} && git checkout ${targetBranch}`,
    dry: flag.dry
  })
} else {
  log.info(`branch:     ${currentBranch || '(detached)'}`)
}

// Pull
log.info('pulling latest...')
await $.exec({
  command: `cd ${repoRoot} && git pull`,
  dry: flag.dry
})

// Install — at the repo root so workspace hoisting works in a monorepo
if (flag.install === false) {
  log.info('skipping bun install (--no-install)')
} else {
  log.info('installing deps...')
  await $.exec({
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
  await $.exec({
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
