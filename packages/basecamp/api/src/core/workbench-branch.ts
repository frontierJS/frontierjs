// src/core/workbench-branch.ts — the git half of a workbench branch: a pinned
// checkout's tree snapshotted, a linked worktree cut from the snapshot, the
// branch's work applied back, the worktree removed (IDEAS/workbench-branches.md).
//
// The parent is never clean and other sessions edit it, so nothing here writes
// its index, its HEAD or a ref it holds. A snapshot goes through a TEMPORARY
// index — the real one is copied and only read — and lands as a dangling
// commit whose parent is HEAD. Land writes the parent's working tree and
// nothing else, and only after `git apply --check` has passed: a patch that
// does not apply is refused naming its files, never written as conflict
// markers into a tree someone else is in.
//
// Git is called as `core/workbench-diff.ts` calls it, every path one argv
// element, never a shell string.

import { execFileSync }                       from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir }                             from 'node:os'
import { join }                               from 'node:path'

/** A snapshot names at most this many of the files it carried beyond HEAD. */
export const MAX_CARRIED = 50

// The snapshot is the workbench's commit, not the operator's; a machine with
// no git identity configured would otherwise refuse to make it.
const IDENT = {
  GIT_AUTHOR_NAME: 'Basecamp workbench', GIT_AUTHOR_EMAIL: 'workbench@localhost',
  GIT_COMMITTER_NAME: 'Basecamp workbench', GIT_COMMITTER_EMAIL: 'workbench@localhost',
}

class GitError extends Error {
  constructor(readonly argv: string[], readonly stderr: string) {
    super(stderr.trim() || `git ${argv[0]} failed`)
  }
}

function git(root: string, argv: string[], { env = {}, input }: { env?: Record<string, string>, input?: string } = {}): string {
  try {
    return execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', '--no-optional-locks', '-C', root, ...argv], {
      encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, ...env }, input,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
  } catch (e) {
    throw new GitError(argv, String((e as { stderr?: unknown }).stderr ?? (e as Error).message))
  }
}

const lines = (out: string) => out.split('\n').filter(Boolean)

/**
 * The working tree as a commit, untracked files included and ignored ones
 * not. The tree is HEAD's own when nothing differs, and HEAD is the answer.
 */
export function snapshot(root: string): { base: string, carried: { total: number, files: string[] } } {
  const head = git(root, ['rev-parse', '--verify', 'HEAD^{commit}']).trim()
  const real = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index']).trim()
  const tmp  = mkdtempSync(join(tmpdir(), 'workbench-index-'))
  const index = join(tmp, 'index')
  try {
    // Copied so `add -A` re-hashes only what changed since the operator's own
    // last add, rather than every file in the tree.
    if (existsSync(real)) copyFileSync(real, index)
    const env = { GIT_INDEX_FILE: index }
    git(root, ['add', '-A'], { env })
    const tree = git(root, ['write-tree'], { env }).trim()
    if (tree === git(root, ['rev-parse', `${head}^{tree}`]).trim()) return { base: head, carried: { total: 0, files: [] } }
    const base  = git(root, ['commit-tree', tree, '-p', head, '-m', 'workbench snapshot'], { env: IDENT }).trim()
    const files = lines(git(root, ['diff', '--name-only', '--no-renames', head, base]))
    return { base, carried: { total: files.length, files: files.slice(0, MAX_CARRIED) } }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** `wb/<slug>`, or why a slug cannot name a branch. */
export function branchName(root: string, slug: string): { branch: string } | { refused: string } {
  if (!/^[a-z0-9][a-z0-9._-]{0,47}$/.test(slug)) return { refused: `'${slug}' is not a branch name — lowercase letters, digits, '.', '_' and '-', up to 48` }
  const branch = `wb/${slug}`
  try { git(root, ['check-ref-format', '--branch', branch]) } catch { return { refused: `'${branch}' is not a valid git branch name` } }
  try {
    git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    return { refused: `the branch '${branch}' already exists in this repository` }
  } catch {}
  return { branch }
}

/** A new branch at `base`, checked out at `path`. */
export function addWorktree(root: string, path: string, branch: string, base: string) {
  git(root, ['worktree', 'add', '--quiet', '-b', branch, path, base])
}

/** The worktree gone, its branch kept. */
export function removeWorktree(root: string, path: string) {
  try { git(root, ['worktree', 'remove', '--force', path]) }
  catch (e) {
    // Already deleted by hand: the registration is all that is left.
    if (existsSync(path)) throw e
    git(root, ['worktree', 'prune'])
  }
}

/**
 * What the branch's tree holds that `base` does not — committed or not,
 * untracked included — without writing anything.
 */
export function pendingFiles(path: string, base: string): string[] {
  const tracked   = lines(git(path, ['diff', '--name-only', '--no-renames', base]))
  const untracked = git(path, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)
  return [...new Set([...tracked, ...untracked])]
}

// `git apply` names a file in each of these; the rest of its stderr is context.
const APPLY_FILE = [
  /^error: patch failed: (.+):\d+$/,
  /^error: (.+): already exists in working directory$/,
  /^error: (.+): does not exist in working directory$/,
  /^error: (.+): does not match index$/,
  /^error: (.+): No such file or directory$/,
]

function refusedFiles(stderr: string): string[] {
  const out = new Set<string>()
  for (const line of lines(stderr))
    for (const re of APPLY_FILE) { const m = line.match(re); if (m) { out.add(m[1]); break } }
  return [...out]
}

/**
 * The branch's work since `base` applied to `parent`'s working tree. Either
 * every file lands or none does.
 */
export function land(parent: string, path: string, base: string):
  | { landed: string[], base: string }
  | { refused: string, files?: string[] } {
  const snap  = snapshot(path).base
  const files = lines(git(path, ['diff', '--name-only', '--no-renames', base, snap]))
  if (!files.length) return { refused: 'nothing to land — the branch holds nothing its base does not' }
  const patch = git(path, ['diff', '--binary', '--full-index', '--no-renames', '--no-color', '--no-ext-diff', base, snap])
  try { git(parent, ['apply', '--check', '--binary', '-'], { input: patch }) }
  catch (e) {
    const named = refusedFiles((e as GitError).stderr ?? '')
    return {
      refused: `the parent's tree has moved under ${named.length ? named.join(', ') : 'the branch'} — nothing was applied`,
      files: named,
    }
  }
  git(parent, ['apply', '--binary', '-'], { input: patch })
  return { landed: files, base: snap }
}
