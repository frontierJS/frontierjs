// src/core/site-checkout.ts — basecamp's checkout of a static site's repository,
// where an owner's draft is written (`FJS-D1227`, `FJS-D1228`).
//
// A bare clone per App under `SITES_DIR` (default ~/.config/basecamp/sites),
// fetched before every read and every save. A draft is the branch
// `draft/<slug>` ON THE REMOTE: each save is one commit pushed there, so the
// clone is a cache, a draft survives losing this disk, and a developer sees it
// as a branch. The push is the lock — two people saving one draft at once
// race to a fast-forward, and the second is refused rather than merged.
//
// A save never touches a working tree. The commit is built from the draft's
// tree through a temporary index, so nothing a repository carries runs here:
// there is no checkout to run a filter or a hook on, and every call pins
// `core.fsmonitor` and `core.hooksPath` off besides.
//
// The repository URL is an admin's, and reaches git after `--`, so one shaped
// like an option is a URL that fails rather than a flag. The credential is
// whatever this host's git already holds; a deploy key per repository is owed
// (`FJS-D1228`). `GIT_TERMINAL_PROMPT=0` makes a missing one a refusal rather
// than a request that waits forever for a password.

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { env } from './env.ts'

export interface GitSite {
  id:      string
  source:  { repo: string, branch?: string, path?: string }
}

export interface Draft {
  name:     string
  branch:   string
  head:     string
  at:       string
  author:   string
  subject:  string
}

export interface Author { name: string, email: string }

export class CheckoutError extends Error {}

/** The draft moved under the caller: what they read is no longer its head. */
export class StaleDraft extends CheckoutError {}

const DRAFT_PREFIX = 'draft/'

export function sitesDir(): string {
  return env.SITES_DIR || join(homedir(), '.config', 'basecamp', 'sites')
}

function git(dir: string, argv: string[], { input, env: extra = {} }: { input?: string, env?: Record<string, string> } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', [
      '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.quotePath=false',
      '-C', dir, ...argv,
    ], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extra },
    }, (err, stdout, stderr) => {
      if (err) reject(new CheckoutError(String(stderr || err.message).trim()))
      else resolve(stdout)
    })
    if (input !== undefined) child.stdin!.end(input)
  })
}

// One git sequence per site at a time: a fetch and a save's ref update both
// take the clone's ref locks, and two at once refuse each other.
const queues = new Map<string, Promise<unknown>>()
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(fn)
  queues.set(key, run)
  return run
}

/** The draft's branch for a name a person typed, or why it cannot be one. */
export function draftBranch(name: unknown): { branch: string, slug: string } | { refused: string } {
  const slug = String(name ?? '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
  if (!/^[a-z]/.test(slug)) return { refused: 'a draft is named with a word, starting with a letter' }
  return { branch: DRAFT_PREFIX + slug, slug }
}

/** A path under the site root, as the repository names it. */
function repoPath(site: GitSite, path: string): string {
  const base = (site.source.path ?? '').replace(/^\/+|\/+$/g, '')
  return base ? `${base}/${path}` : path
}

/** The clone, made the first time and fetched every time after. */
async function synced(site: GitSite, root: string): Promise<string> {
  const dir = join(root, `${site.id}.git`)
  if (!existsSync(dir)) {
    mkdirSync(root, { recursive: true })
    await git(root, ['clone', '--bare', '--quiet', '--', site.source.repo, dir]).catch((err) => {
      rmSync(dir, { recursive: true, force: true })
      throw new CheckoutError(`could not clone ${site.source.repo}: ${err.message}`)
    })
    await git(dir, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'])
  }
  await git(dir, ['fetch', '--quiet', '--prune', 'origin']).catch((err) => {
    throw new CheckoutError(`could not fetch ${site.source.repo}: ${err.message}`)
  })
  return dir
}

/** The branch drafts start from: the source's, or the remote's default. */
async function baseBranch(site: GitSite, dir: string): Promise<string> {
  if (site.source.branch) return site.source.branch
  const head = (await git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim()
  if (!head) throw new CheckoutError(`${site.source.repo} names no default branch — set one on the App's source`)
  return head
}

async function headOf(dir: string, branch: string): Promise<string | null> {
  const out = await git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}^{commit}`]).catch(() => '')
  return out.trim() || null
}

export function listDrafts(site: GitSite, root = sitesDir()): Promise<Draft[]> {
  return serial(site.id, async () => {
    const dir = await synced(site, root)
    const out = await git(dir, ['for-each-ref', '--sort=-committerdate',
      '--format=%(refname:strip=3)%00%(objectname)%00%(committerdate:iso-strict)%00%(authorname)%00%(subject)',
      `refs/remotes/origin/${DRAFT_PREFIX}`])
    return out.split('\n').filter(Boolean).map((line) => {
      const [branch, head, at, author, subject] = line.split('\0')
      return { name: branch.slice(DRAFT_PREFIX.length), branch, head, at: new Date(at).toISOString(), author, subject }
    })
  })
}

/** A new draft: its branch pushed at the base branch's head, with no commit of its own. */
export function openDraft(site: GitSite, name: unknown, root = sitesDir()): Promise<Draft> {
  const named = draftBranch(name)
  if ('refused' in named) return Promise.reject(new CheckoutError(named.refused))
  return serial(site.id, async () => {
    const dir = await synced(site, root)
    if (await headOf(dir, named.branch)) throw new CheckoutError(`a draft named ${named.slug} is already open`)
    const base = await baseBranch(site, dir)
    const head = await headOf(dir, base)
    if (!head) throw new CheckoutError(`${site.source.repo} has no branch ${base}`)
    await git(dir, ['push', '--quiet', 'origin', `${head}:refs/heads/${named.branch}`]).catch((err) => {
      throw new CheckoutError(`could not push ${named.branch}: ${err.message}`)
    })
    await git(dir, ['update-ref', `refs/remotes/origin/${named.branch}`, head])
    const [at, author, subject] = (await git(dir, ['log', '-1', '--format=%cI%x00%an%x00%s', head])).trim().split('\0')
    return { name: named.slug, branch: named.branch, head, at: new Date(at).toISOString(), author, subject }
  })
}

async function draftHead(site: GitSite, dir: string, draft: string): Promise<{ branch: string, head: string }> {
  const named = draftBranch(draft)
  if ('refused' in named) throw new CheckoutError(named.refused)
  const head = await headOf(dir, named.branch)
  if (!head) throw new CheckoutError(`no draft named ${draft} — it may have been published or deleted`)
  return { branch: named.branch, head }
}

/** Every file under the site's `content/` on a draft, as paths from the site root. */
export function draftFiles(site: GitSite, draft: string, root = sitesDir()): Promise<string[]> {
  return serial(site.id, async () => {
    const dir = await synced(site, root)
    const { head } = await draftHead(site, dir, draft)
    const prefix = repoPath(site, '')
    const out = await git(dir, ['ls-tree', '-r', '-z', '--name-only', head, '--', repoPath(site, 'content')])
    return out.split('\0').filter(Boolean).map((p) => p.slice(prefix.length))
  })
}

/** One file on a draft, with the blob a save names to prove it read this one. */
export function readDraftFile(site: GitSite, draft: string, path: string, root = sitesDir()):
  Promise<{ text: string, blob: string, head: string }> {
  return serial(site.id, async () => {
    const dir = await synced(site, root)
    const { head } = await draftHead(site, dir, draft)
    const blob = await blobAt(dir, head, repoPath(site, path))
    if (!blob) throw new CheckoutError(`${path} is not on the draft ${draft}`)
    return { text: await git(dir, ['cat-file', 'blob', blob.id]), blob: blob.id, head }
  })
}

async function blobAt(dir: string, commit: string, path: string): Promise<{ id: string, mode: string } | null> {
  const out = (await git(dir, ['ls-tree', '-z', commit, '--', path])).split('\0')[0]
  const m = /^(\d+) blob ([0-9a-f]+)\t/.exec(out ?? '')
  return m ? { mode: m[1], id: m[2] } : null
}

/**
 * `text` as `path` on the draft, one commit pushed. `blob` is the one the
 * caller read: a file someone changed since is refused by name, and a push
 * that loses the race to another save is refused the same way.
 */
export function saveDraftFile(site: GitSite, draft: string, change: { path: string, blob: string, text: string, message: string },
  author: Author, root = sitesDir()): Promise<{ commit: string, blob: string }> {
  return serial(site.id, async () => {
    const dir = await synced(site, root)
    const { branch, head } = await draftHead(site, dir, draft)
    const path = repoPath(site, change.path)
    const now = await blobAt(dir, head, path)
    if (!now) throw new CheckoutError(`${change.path} is not on the draft ${draft}`)
    if (now.id !== change.blob) throw new StaleDraft(`${change.path} changed on this draft since you opened it — open it again`)

    const blob = (await git(dir, ['hash-object', '-w', '--stdin'], { input: change.text })).trim()
    if (blob === now.id) return { commit: head, blob }

    const tmp = mkdtempSync(join(tmpdir(), 'basecamp-draft-'))
    try {
      const index = { GIT_INDEX_FILE: join(tmp, 'index') }
      await git(dir, ['read-tree', head], { env: index })
      await git(dir, ['update-index', '--cacheinfo', `${now.mode},${blob},${path}`], { env: index })
      const tree = (await git(dir, ['write-tree'], { env: index })).trim()
      const who = {
        GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email,
      }
      const commit = (await git(dir, ['commit-tree', tree, '-p', head, '-F', '-'], { input: change.message + '\n', env: who })).trim()
      await git(dir, ['push', '--quiet', 'origin', `${commit}:refs/heads/${branch}`]).catch((err) => {
        if (/non-fast-forward|fetch first|rejected/.test(err.message))
          throw new StaleDraft(`someone else saved to ${draft} first — open the file again`)
        throw new CheckoutError(`could not push ${branch}: ${err.message}`)
      })
      await git(dir, ['update-ref', `refs/remotes/origin/${branch}`, commit])
      return { commit, blob }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
}
