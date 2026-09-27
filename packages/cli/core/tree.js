// ─── tree — the files a clone of this root would hold ───────────────────────
//
// A check that asks the DISK answers for this machine: an ignored build output,
// a sibling checkout, a vscode `out/` are all there locally and absent on a
// fresh clone, so a committed snapshot or a register graded that way is green
// here and red on every runner (FJS-009). Tracked files plus untracked ones git
// does not ignore — the second half is the file a change is about to commit.
//
// **No git, no answer**: `null`, and the caller falls back to the disk. A root
// with no repository has nothing to disagree with.
//
// Zero dependencies, plain ESM, node or bun — a caller runs before install.

import { spawnSync }  from 'node:child_process'
import { posix }      from 'node:path'

export function treePaths(root) {
  const run = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root, encoding: 'utf8', shell: false, timeout: 20_000, maxBuffer: 1 << 28,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  })
  if (run.error || run.status !== 0) return null

  const files = new Set()
  const dirs  = new Set()
  for (const p of (run.stdout ?? '').split('\0')) {
    if (!p) continue
    files.add(p)
    for (let d = posix.dirname(p); d !== '.'; d = posix.dirname(d)) {
      if (dirs.has(d)) break
      dirs.add(d)
    }
  }
  // Relative to `root`, which is what `git ls-files` answers from its cwd. A
  // trailing slash is a directory link written the way a reader writes one.
  return { files, has: p => { const k = p.replace(/\/+$/, ''); return files.has(k) || dirs.has(k) } }
}
