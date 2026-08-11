#!/usr/bin/env node
// ============================================================
// Install the repo's git hooks
//
//   bun run hooks:install     # point git at scripts/hooks
//   bun run hooks:install -- --uninstall
//
// Uses `core.hooksPath` rather than copying files into .git/hooks. A copy goes
// stale the moment the hook is edited and nothing says so, because .git/hooks
// is not in git and a diff can never show it. Pointing git at a tracked
// directory means the hook everyone runs is the hook in the repo.
//
// core.hooksPath is per-clone local config, so this has to be run once per
// clone. That is the trade for hooks that cannot drift.
// ============================================================

import { spawnSync }              from 'node:child_process'
import { existsSync, readdirSync, chmodSync } from 'node:fs'
import { join, dirname }          from 'node:path'
import { fileURLToPath }          from 'node:url'

const ROOT      = dirname(dirname(fileURLToPath(import.meta.url)))
const HOOKS_DIR = 'scripts/hooks'
const uninstall = process.argv.includes('--uninstall')

if (uninstall) {
  git(['config', '--unset', 'core.hooksPath'], { allowFailure: true })
  console.log('[hooks] core.hooksPath unset — git is back to .git/hooks')
  process.exit(0)
}

// A hook git will never run is worse than no hook: it reads as installed.
// .git/hooks ships .sample files that are inert; anything else there is a real
// hook that core.hooksPath is about to shadow.
const existing = gitPath('hooks')
if (existing && existsSync(existing)) {
  const live = readdirSync(existing).filter(f => !f.endsWith('.sample'))
  if (live.length) {
    console.log(`[hooks] .git/hooks still contains ${live.join(', ')} — git will stop running them once core.hooksPath is set.`)
  }
}

// A hook without the executable bit is skipped by git silently. Setting it here
// covers a checkout on a filesystem that dropped the mode.
for (const file of readdirSync(join(ROOT, HOOKS_DIR))) {
  chmodSync(join(ROOT, HOOKS_DIR, file), 0o755)
}

git(['config', 'core.hooksPath', HOOKS_DIR])

console.log(`[hooks] core.hooksPath = ${HOOKS_DIR}`)
console.log(`[hooks] installed: ${readdirSync(join(ROOT, HOOKS_DIR)).join(', ')}`)
console.log(`[hooks] pre-push runs \`node scripts/ci.mjs --fast\` — bypass with \`git push --no-verify\`, remove with \`bun run hooks:install -- --uninstall\``)

// ─── helpers ────────────────────────────────────────────────

function git(argv, { allowFailure = false } = {}) {
  const r = spawnSync('git', argv, { cwd: ROOT, encoding: 'utf8', shell: false })
  if (!allowFailure && r.status !== 0) {
    console.error(`[hooks] git ${argv.join(' ')} failed: ${r.stderr ?? `exit ${r.status}`}`)
    process.exit(1)
  }
  return (r.stdout ?? '').trim()
}

// `--git-path` resolves correctly inside a worktree, where .git is a file.
function gitPath(name) {
  const r = spawnSync('git', ['rev-parse', '--git-path', name], { cwd: ROOT, encoding: 'utf8', shell: false })
  if (r.status !== 0) return null
  const path = (r.stdout ?? '').trim()
  return path.startsWith('/') ? path : join(ROOT, path)
}
