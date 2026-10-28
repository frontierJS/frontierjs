// ─── git.js — one way core asks git a question ───────────────────────────────
//
// `gitOut(root, argv)` → stdout, or null when git is absent, the directory is
// not a checkout, git exits non-zero, or the timeout passes. null is not '':
// a caller that means "no output" writes `?? ''` and says so.
//
// argv, never a shell string: a branch or path a caller passes cannot become a
// second command.
//
// GIT_OPTIONAL_LOCKS=0 and a timeout on every call. Without them a read that
// refreshes the index waits on a stale `index.lock` left by a crashed git, and
// `fli done` hangs where `fli tree` did not.
//
// A question asked from a package directory answers repo-wide unless the argv
// carries a pathspec.

import { spawnSync } from 'node:child_process'

const TIMEOUT    = 20_000
const MAX_BUFFER = 1 << 28

export function gitOut(root, argv, { input, timeout = TIMEOUT, maxBuffer = MAX_BUFFER } = {}) {
  const run = spawnSync('git', argv, {
    cwd: root, encoding: 'utf8', shell: false, timeout, maxBuffer, input,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  })
  return run.error || run.status !== 0 ? null : run.stdout
}
