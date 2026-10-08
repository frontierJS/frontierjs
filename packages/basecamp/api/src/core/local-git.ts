// src/core/local-git.ts — the git repositories under a folder on the operator's own machine.
//
// A development affordance, the sibling of `core/local-ssh.ts`: Basecamp
// running locally lists the projects its operator already has checked out —
// where each one is, which branch it is on, whether it has uncommitted work,
// and the remote an App's `git` source would name.
//
// **Off unless `LOCAL_MACHINE=1`, and refused under `NODE_ENV=production` even
// then** (`localMachineRefusal`, `core/env.ts`). On a deployed control plane
// the folder would be the SERVER's disk, readable by any admin.
//
// What leaves this file is metadata — a path, a branch, counts, a remote, the
// last commit's subject. No file content is read, and a remote's credential is
// cut out of the URL before it is returned (`https://user:token@host/…` is how
// a token checkout is spelled, and the screen draws the remote).
//
// `git status` in a repository runs code that repository's config names:
// `core.fsmonitor` is a command, started on every status. A cloned repo cannot
// set it — `.git/config` is not cloned — but a copied or downloaded tree can,
// so every call here pins it off. `--no-optional-locks` keeps a status from
// rewriting the index, so a scan writes nothing into any repository.
//
// Every path that reaches git is one this file found by walking the root, and
// it is one argv element after `-C` — never a shell, never a caller's string.

import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative } from 'node:path'

export type LocalRepo = {
  path:          string
  relative:      string
  name:          string
  /** null on a detached HEAD. */
  branch:        string | null
  head:          string | null
  upstream:      string | null
  ahead:         number
  behind:        number
  /** Entries `git status` reports — staged, unstaged and untracked together. */
  changes:       number
  remote:        string | null
  /** UTC, so two repositories order by it as strings — `%cI` carries the
   *  committer's own offset, and a DST change alone flips a string compare. */
  lastCommitAt:  string | null
  lastCommit:    string | null
  /** A `frontier.config.js` at the repository root — a FrontierJS app. */
  frontier:      boolean
}

/** Directories a project tree holds thousands of and no repository lives in. */
const SKIP = new Set(['node_modules', 'vendor', 'dist', 'build', 'target', '__pycache__'])

/**
 * The folder a caller named, as an absolute real path — or why it is refused.
 * `~/` is the operator's home; anything else must be absolute, because a
 * relative path would be read against the API's working directory.
 */
export function resolveRoot(input: unknown): { root: string } | { refused: string } {
  if (typeof input !== 'string' || !input.trim()) return { refused: 'root is required — the folder to look in' }
  const raw = input.trim()
  const expanded = raw === '~' ? homedir() : raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw
  if (!isAbsolute(expanded)) return { refused: `'${raw}' is not an absolute path — start it with / or ~/` }
  let root: string
  try { root = realpathSync(expanded) } catch { return { refused: `'${raw}' does not exist` } }
  if (!statSync(root).isDirectory()) return { refused: `'${raw}' is not a folder` }
  return { root }
}

/**
 * Every directory under `root` holding a `.git`, nearest first. A repository is
 * not descended into — a nested checkout inside one is its submodule or its
 * build output, not a second project. Symlinks are not followed, so a link back
 * up the tree cannot loop. `.git` as a FILE is a worktree or a submodule
 * checkout, and counts.
 */
export function findRepoDirs(root: string, { depth = 4, limit = 500 } = {}): { dirs: string[], truncated: boolean } {
  const dirs: string[] = []
  let level = [root]
  for (let d = 0; d <= depth && level.length; d++) {
    const next: string[] = []
    for (const dir of level) {
      let entries
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
      if (entries.some(e => e.name === '.git' && (e.isDirectory() || e.isFile()))) {
        dirs.push(dir)
        if (dirs.length >= limit) return { dirs, truncated: true }
        continue
      }
      for (const e of entries)
        if (e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name)) next.push(join(dir, e.name))
    }
    level = next.sort()
  }
  return { dirs, truncated: false }
}

/** A remote with its credential cut out. Over http a bare username is usually
 *  a token too; over ssh `git@` is the account and stays. */
export function redactRemote(url: string): string {
  const m = url.match(/^([a-z][a-z0-9+.-]*:\/\/)([^@/]*)@(.*)$/i)
  if (!m) return url
  const [, scheme, userinfo, rest] = m
  if (/^https?:\/\/$/i.test(scheme) || userinfo.includes(':')) return scheme + rest
  return url
}

/** `git status --porcelain=v2 --branch`, reduced to the branch and a count. */
export function parseStatus(output: string) {
  const out = { branch: null as string | null, head: null as string | null, upstream: null as string | null, ahead: 0, behind: 0, changes: 0 }
  for (const line of output.split('\n')) {
    if (!line) continue
    if (!line.startsWith('# ')) { out.changes++; continue }
    const [, key, ...rest] = line.split(' ')
    const value = rest.join(' ')
    if (key === 'branch.oid')      out.head = value === '(initial)' ? null : value.slice(0, 7)
    if (key === 'branch.head')     out.branch = value === '(detached)' ? null : value
    if (key === 'branch.upstream') out.upstream = value
    if (key === 'branch.ab') {
      const ab = value.match(/^\+(\d+) -(\d+)$/)
      if (ab) { out.ahead = Number(ab[1]); out.behind = Number(ab[2]) }
    }
  }
  return out
}

/** `git config --get-regexp` over remote URLs — origin when there is one, else the first. */
export function pickRemote(output: string): string | null {
  const remotes = output.split('\n').filter(Boolean).map(l => {
    const [key, ...url] = l.split(' ')
    return { name: key.replace(/^remote\.|\.url$/g, ''), url: url.join(' ') }
  })
  const pick = remotes.find(r => r.name === 'origin') ?? remotes[0]
  return pick ? redactRemote(pick.url) : null
}

async function git(dir: string, args: string[]): Promise<string | null> {
  const proc = Bun.spawn(['git', '-c', 'core.fsmonitor=false', '--no-optional-locks', '-C', dir, ...args], {
    stdout: 'pipe', stderr: 'ignore',
    env:    { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  })
  const out  = await new Response(proc.stdout).text()
  const code = await proc.exited
  return code === 0 ? out : null
}

export async function describeRepo(root: string, dir: string): Promise<LocalRepo> {
  const [status, remotes, log] = await Promise.all([
    git(dir, ['status', '--porcelain=v2', '--branch']),
    git(dir, ['config', '--get-regexp', '^remote\\..*\\.url$']),
    // An empty repository has no commit, and `log` exits non-zero on it.
    git(dir, ['log', '-1', '--format=%cI%x00%s']),
  ])
  const s = parseStatus(status ?? '')
  const [at, subject] = (log ?? '').trim().split('\0')
  return {
    path:         dir,
    relative:     relative(root, dir) || '.',
    name:         basename(dir),
    ...s,
    remote:       pickRemote(remotes ?? ''),
    lastCommitAt: at ? new Date(at).toISOString() : null,
    lastCommit:   subject ?? null,
    frontier:     existsSync(join(dir, 'frontier.config.js')),
  }
}

/** The repositories under `root`, eight git processes at a time. */
export async function listLocalRepos(root: string, opts: { depth?: number, limit?: number } = {}) {
  const { dirs, truncated } = findRepoDirs(root, opts)
  const repos: LocalRepo[] = new Array(dirs.length)
  let i = 0
  await Promise.all(Array.from({ length: Math.min(8, dirs.length) }, async () => {
    while (i < dirs.length) { const n = i++; repos[n] = await describeRepo(root, dirs[n]) }
  }))
  return { root, repos, truncated }
}
