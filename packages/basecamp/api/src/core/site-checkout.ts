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
// A publish merges the draft into the site's branch the same way, through a
// temporary index and `git merge-file` on blobs, with no working tree: a
// commit is pushed to the draft first, built and deployed from there, and
// only then is the site's branch moved to it, so a failed build leaves the
// branch where the last release left it (`FJS-D1229`). Revert is the same
// merge run backwards onto the site's branch, landing as a new draft.
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { childEnv } from '@frontierjs/junction'
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

function git(dir: string, argv: string[], opts: { input?: string | Uint8Array, env?: Record<string, string> } = {}): Promise<string> {
  return gitRun(dir, argv, opts).then(({ code, stdout, stderr }) => {
    if (code !== 0) throw new CheckoutError(String(stderr || `git ${argv[0]} exited ${code}`).trim())
    return stdout
  })
}

/** git, answering its exit code rather than refusing on one — `merge-file` counts conflicts in it. */
function gitRun(dir: string, argv: string[], { input, env: extra = {} }: { input?: string | Uint8Array, env?: Record<string, string> } = {}):
  Promise<{ code: number, stdout: string, stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', [
      '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.quotePath=false',
      '-C', dir, ...argv,
    ], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000,
      env: { ...childEnv(env), GIT_TERMINAL_PROMPT: '0', ...extra },
    }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0
      if (code === -1) reject(new CheckoutError(String(stderr || err!.message).trim()))
      else resolve({ code, stdout, stderr })
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
export async function saveDraftFile(site: GitSite, draft: string, change: { path: string, blob: string, text: string, message: string },
  author: Author, root = sitesDir()): Promise<{ commit: string, blob: string }> {
  const { commit, blobs } = await saveDraftFiles(site, draft, { files: [change], message: change.message }, author, root)
  return { commit, blob: blobs[0] as string }
}

/** One file of a several-file save: a null `blob` is a file that must not exist yet, a null `text` deletes it, and bytes are a photo. */
export interface FileChange { path: string, blob: string | null, text: string | Uint8Array | null }

/**
 * Several files on the draft as one commit pushed, the way a collection's
 * reorder writes each item's place. Each change's `blob` is checked as
 * `saveDraftFile` checks its one; nothing changed is no commit.
 */
export function saveDraftFiles(site: GitSite, draft: string, change: { files: FileChange[], message: string },
  author: Author, root = sitesDir()): Promise<{ commit: string, blobs: (string | null)[] }> {
  return serial(site.id, async () => {
    const dir = await synced(site, root)
    const { branch, head } = await draftHead(site, dir, draft)
    // `update-index --index-info` rows: a zero mode removes the path, and
    // needs no work tree, which this bare clone does not have.
    const rows: string[] = []
    const blobs: (string | null)[] = []
    for (const f of change.files) {
      const path = repoPath(site, f.path)
      const now = await blobAt(dir, head, path)
      if (f.blob === null && now) throw new StaleDraft(`${f.path} is already on the draft ${draft} — open it again`)
      if (f.blob !== null && !now) throw new CheckoutError(`${f.path} is not on the draft ${draft}`)
      if (f.blob !== null && now!.id !== f.blob) throw new StaleDraft(`${f.path} changed on this draft since you opened it — open it again`)
      if (f.text === null) {
        rows.push(`0 ${'0'.repeat(40)}\t${path}`)
        blobs.push(null)
        continue
      }
      const blob = (await git(dir, ['hash-object', '-w', '--stdin'], { input: f.text })).trim()
      blobs.push(blob)
      if (blob !== now?.id) rows.push(`${now?.mode ?? '100644'} ${blob}\t${path}`)
    }
    if (!rows.length) return { commit: head, blobs }

    const tmp = mkdtempSync(join(tmpdir(), 'basecamp-draft-'))
    try {
      const index = { GIT_INDEX_FILE: join(tmp, 'index') }
      await git(dir, ['read-tree', head], { env: index })
      await git(dir, ['update-index', '--index-info'], { env: index, input: rows.join('\n') + '\n' })
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
      return { commit, blobs }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
}

/** Every `.md` directly in `folder` on a draft, each with its text and blob — a collection's items. */
export function readDraftFolder(site: GitSite, draft: string, folder: string, root = sitesDir()):
  Promise<Array<{ path: string, text: string, blob: string }>> {
  return serial(site.id, async () => {
    const dir = await synced(site, root)
    const { head } = await draftHead(site, dir, draft)
    const prefix = repoPath(site, '')
    const out = await git(dir, ['ls-tree', '-z', head, '--', repoPath(site, folder) + '/'])
    const files = []
    for (const row of out.split('\0').filter(Boolean)) {
      const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(row)
      if (!m || !m[2].endsWith('.md')) continue
      files.push({ path: m[2].slice(prefix.length), blob: m[1], text: await git(dir, ['cat-file', 'blob', m[1]]) })
    }
    return files
  })
}

// ─── An ask's copy ───────────────────────────────────────────────────────
// A model's run edits files, so it gets a folder: the draft's markdown written
// out under `into/content/`, and back as a tree once it ends (`FJS-D1242`).
// Only `.md` regular files go out, so a symlink in the repository cannot hand
// the run a path outside the folder, and a photo's bytes never cross a string.

/** A file the run may have changed: its path from the site root, and its blob before (null for one it added). */
export interface Asked { path: string, was: string | null, blob: string }

/** The draft's `content/**.md` under `into`, and the commit and blobs it was read at. */
export function exportDraftContent(site: GitSite, draft: string, into: string, root = sitesDir()):
  Promise<{ head: string, blobs: Map<string, string> }> {
  return serial(site.id, async () => {
    const dir = await synced(site, root)
    const { head } = await draftHead(site, dir, draft)
    const prefix = repoPath(site, '')
    const out = await git(dir, ['ls-tree', '-r', '-z', head, '--', repoPath(site, 'content')])
    const blobs = new Map<string, string>()
    for (const row of out.split('\0').filter(Boolean)) {
      const m = /^100(?:644|755) blob ([0-9a-f]+)\t(.+)$/.exec(row)
      if (!m || !m[2].endsWith('.md')) continue
      const path = m[2].slice(prefix.length)
      const file = join(into, path)
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, await git(dir, ['cat-file', 'blob', m[1]]))
      blobs.set(path, m[1])
    }
    return { head, blobs }
  })
}

/**
 * What a run left under `into`, as a tree on `head`: each file whose bytes
 * differ from the blob it went out as, or that went out as nothing. A file the
 * run made outside `content/` is not read, since only that folder went out and
 * the run's tools reach no further. Nothing is committed; the tree is what a
 * later save commits.
 */
export function treeFromExport(site: GitSite, head: string, into: string, blobs: Map<string, string>, root = sitesDir()):
  Promise<{ tree: string, files: Asked[] }> {
  return serial(site.id, async () => {
    const dir = await synced(site, root)
    const files: Asked[] = []
    for (const path of filesUnder(join(into, 'content'), 'content')) {
      const blob = (await git(dir, ['hash-object', '-w', '--stdin'], { input: readFileSync(join(into, path)) })).trim()
      const was = blobs.get(path) ?? null
      if (blob !== was) files.push({ path, was, blob })
    }
    const rows = files.map(f => `100644 ${f.blob}\t${repoPath(site, f.path)}`)
    if (!rows.length) return { tree: (await git(dir, ['rev-parse', `${head}^{tree}`])).trim(), files }
    const tmp = mkdtempSync(join(tmpdir(), 'basecamp-ask-'))
    try {
      const index = { GIT_INDEX_FILE: join(tmp, 'index') }
      await git(dir, ['read-tree', head], { env: index })
      await git(dir, ['update-index', '--index-info'], { env: index, input: rows.join('\n') + '\n' })
      return { tree: (await git(dir, ['write-tree'], { env: index })).trim(), files }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
}

/** Regular files under `dir`, sorted, as `/`-joined paths starting with `rel`; a symlink is not followed. */
function filesUnder(dir: string, rel: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).sort((x, y) => x.name < y.name ? -1 : 1).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name), `${rel}/${e.name}`)
      : e.isFile() ? [`${rel}/${e.name}`] : [])
}

// ─── Publish ─────────────────────────────────────────────────────────────

export interface Commit { id: string, author: string, subject: string }

/** Refused because the draft and the site's branch changed the same lines. */
export class MergeConflict extends CheckoutError {
  constructor(message: string, readonly paths: string[]) { super(message) }
}

export interface Merged {
  /** The merge commit, pushed to the draft's branch and built from there. */
  commit:   string
  /** The site's branch, and the head the merge was made on. */
  base:     string
  baseHead: string
  /** The draft's head before the merge, and the files it changes. */
  draft:    { branch: string, head: string }
  paths:    string[]
}

/**
 * The commits on the site's branch that `released` — the last release's
 * commit — does not hold, or why there is no answer. The branch is the
 * developer's and an owner cannot judge a commit of theirs, so any one of
 * these refuses a publish, naming each author.
 */
export function unreleased(site: GitSite, released: string | null, root = sitesDir()): Promise<{ base: string, head: string, commits: Commit[] }> {
  return serial(site.id, async () => {
    const dir  = await synced(site, root)
    const base = await baseBranch(site, dir)
    const head = await headOf(dir, base)
    if (!head) throw new CheckoutError(`${site.source.repo} has no branch ${base}`)
    if (!released) return { base, head, commits: [] }
    const known = await gitRun(dir, ['cat-file', '-e', `${released}^{commit}`])
    if (known.code !== 0) throw new CheckoutError(`the last release shipped ${released.slice(0, 7)}, which ${site.source.repo} does not hold — a developer deploys ${base} first`)
    const out = await git(dir, ['log', '--format=%H%x00%an%x00%s', `${released}..${head}`])
    return { base, head, commits: out.split('\n').filter(Boolean).map(l => { const [id, author, subject] = l.split('\0'); return { id, author, subject } }) }
  })
}

/**
 * The draft merged into the site's branch, still at `expectBase` — the head
 * the caller checked — as one commit by `author`, pushed
 * to the DRAFT's branch — a fast-forward of it, so a save that lands first
 * refuses the merge, and the site's branch has not moved yet.
 *
 * Three-way, file by file: a path only one side changed is taken from it, and
 * a path both changed is merged with `git merge-file`; any overlap refuses
 * the publish naming the paths, for a developer to resolve.
 */
export function mergeDraft(site: GitSite, draft: string, author: Author, message: string, expectBase: string, root = sitesDir()): Promise<Merged> {
  return serial(site.id, async () => {
    const dir  = await synced(site, root)
    const { branch, head } = await draftHead(site, dir, draft)
    const base     = await baseBranch(site, dir)
    const baseHead = await headOf(dir, base)
    if (!baseHead) throw new CheckoutError(`${site.source.repo} has no branch ${base}`)
    if (baseHead !== expectBase) throw new CheckoutError(`${base} moved to ${baseHead.slice(0, 7)} while the publish was checked — publish again`)
    const since = (await git(dir, ['merge-base', baseHead, head])).trim()
    const paths = (await git(dir, ['diff', '--name-only', '-z', since, head])).split('\0').filter(Boolean)
    if (!paths.length) throw new CheckoutError(`the draft ${draft} changes nothing that ${base} does not already have`)

    const tmp = mkdtempSync(join(tmpdir(), 'basecamp-publish-'))
    try {
      const index = { GIT_INDEX_FILE: join(tmp, 'index') }
      await git(dir, ['read-tree', '-m', '-i', '--aggressive', since, baseHead, head], { env: index })
      const conflicted = await resolveBoth(dir, tmp, index)
      const prefix = repoPath(site, '').length
      if (conflicted.length)
        throw new MergeConflict(`${draft} and ${base} both changed ${conflicted.map(p => p.slice(prefix)).join(', ')} — a developer merges them`, conflicted)
      const tree = (await git(dir, ['write-tree'], { env: index })).trim()
      const who = {
        GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email,
      }
      const commit = (await git(dir, ['commit-tree', tree, '-p', baseHead, '-p', head, '-F', '-'], { input: message + '\n', env: who })).trim()
      await git(dir, ['push', '--quiet', 'origin', `${commit}:refs/heads/${branch}`]).catch((err) => {
        if (/non-fast-forward|fetch first|rejected/.test(err.message))
          throw new StaleDraft(`someone saved to ${draft} while it was being published — publish again`)
        throw new CheckoutError(`could not push ${branch}: ${err.message}`)
      })
      await git(dir, ['update-ref', `refs/remotes/origin/${branch}`, commit])
      return { commit, base, baseHead, draft: { branch, head }, paths: paths.map(p => p.slice(prefix)) }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
}

/** Every path left unmerged in the index, merged by `git merge-file` where it can be; answers the ones it cannot. */
async function resolveBoth(dir: string, tmp: string, index: Record<string, string>): Promise<string[]> {
  const stages = new Map<string, Record<number, { mode: string, id: string }>>()
  for (const entry of (await git(dir, ['ls-files', '-u', '-z'], { env: index })).split('\0').filter(Boolean)) {
    const m = /^(\d+) ([0-9a-f]+) (\d)\t(.*)$/s.exec(entry)
    if (!m) continue
    stages.set(m[4], { ...stages.get(m[4]), [Number(m[3])]: { mode: m[1], id: m[2] } })
  }
  const conflicted: string[] = []
  for (const [path, s] of stages) {
    // Added on both sides, deleted on one and changed on the other, or a
    // photo: no line-wise answer exists, so a person decides.
    if (!s[1] || !s[2] || !s[3] || s[2].mode !== s[3].mode || !path.endsWith('.md')) { conflicted.push(path); continue }
    const file = (n: number) => join(tmp, `stage${n}`)
    for (const n of [1, 2, 3]) writeFileSync(file(n), await git(dir, ['cat-file', 'blob', s[n].id]))
    const merged = await gitRun(dir, ['merge-file', '-q', '-p', file(2), file(1), file(3)])
    if (merged.code !== 0) { conflicted.push(path); continue }
    const blob = (await git(dir, ['hash-object', '-w', '--stdin'], { input: merged.stdout })).trim()
    await git(dir, ['update-index', '--cacheinfo', `${s[2].mode},${blob},${path}`], { env: index })
  }
  return conflicted
}

/**
 * The site's branch moved to the released merge — a fast-forward, which the
 * merge's first parent makes it unless a developer pushed meanwhile — and the
 * draft's branch removed, unless a save landed on it since.
 */
export function advanceBase(site: GitSite, merged: Merged, root = sitesDir()): Promise<{ draftKept: boolean }> {
  return serial(site.id, async () => {
    const dir = await synced(site, root)
    await git(dir, ['push', '--quiet', 'origin', `${merged.commit}:refs/heads/${merged.base}`]).catch((err) => {
      throw new CheckoutError(`the site is live at ${merged.commit.slice(0, 7)}, and ${merged.base} moved before it could follow — a developer merges ${merged.draft.branch}: ${err.message}`)
    })
    await git(dir, ['update-ref', `refs/remotes/origin/${merged.base}`, merged.commit])
    const gone = await gitRun(dir, ['push', '--quiet', `--force-with-lease=refs/heads/${merged.draft.branch}:${merged.commit}`,
      'origin', `:refs/heads/${merged.draft.branch}`])
    if (gone.code === 0) await gitRun(dir, ['update-ref', '-d', `refs/remotes/origin/${merged.draft.branch}`])
    return { draftKept: gone.code !== 0 }
  })
}

// ─── History ─────────────────────────────────────────────────────────────

export interface Shipped {
  /** Paths from the site root, or null where `from` is no release or a commit this clone does not hold. */
  files:   string[] | null
  /** Who wrote the commits, merges left out — the publisher is the release's author, not a writer. */
  authors: string[]
}

/** What each release shipped over the one before it, read off the site's own path in the repository. */
export function shipped(site: GitSite, ranges: { from: string | null, to: string }[], root = sitesDir()): Promise<Shipped[]> {
  return serial(site.id, async () => {
    const dir    = await synced(site, root)
    const prefix = repoPath(site, '')
    const scope  = prefix ? ['--', prefix] : []
    const held   = async (c: string) => (await gitRun(dir, ['cat-file', '-e', `${c}^{commit}`])).code === 0
    const out: Shipped[] = []
    for (const { from, to } of ranges) {
      if (!from || !(await held(from)) || !(await held(to))) { out.push({ files: null, authors: [] }); continue }
      const files   = (await git(dir, ['diff', '--name-only', '-z', from, to, ...scope])).split('\0').filter(Boolean)
      const authors = (await git(dir, ['log', '--no-merges', '--format=%an', `${from}..${to}`, ...scope])).split('\n').filter(Boolean)
      out.push({ files: files.map(p => p.slice(prefix.length)), authors: [...new Set(authors)] })
    }
    return out
  })
}

/**
 * A new draft `name` holding `commit` undone — a `git revert -m 1`, made as a
 * three-way merge onto the site's branch with `commit` as the base and its
 * first parent as the other side, so later lines a publish did not touch
 * stay. `refusal` grades each path the undo would change before anything is
 * pushed; a later change to the same lines refuses it, naming the files.
 */
export function revertDraft(site: GitSite, commit: string, name: string, author: Author, message: string,
  refusal: (path: string) => string | null, root = sitesDir()): Promise<Draft> {
  const named = draftBranch(name)
  if ('refused' in named) return Promise.reject(new CheckoutError(named.refused))
  return serial(site.id, async () => {
    const dir      = await synced(site, root)
    if (await headOf(dir, named.branch)) throw new CheckoutError(`a draft named ${named.slug} is already open — open that one`)
    const base     = await baseBranch(site, dir)
    const baseHead = await headOf(dir, base)
    if (!baseHead) throw new CheckoutError(`${site.source.repo} has no branch ${base}`)
    if ((await gitRun(dir, ['merge-base', '--is-ancestor', commit, baseHead])).code !== 0)
      throw new CheckoutError(`${commit.slice(0, 7)} is not on ${base} any more, so there is nothing of it to undo`)
    const parent = (await git(dir, ['rev-parse', '--verify', `${commit}^1`])).trim()

    const prefix = repoPath(site, '')
    const paths  = (await git(dir, ['diff', '--name-only', '-z', parent, commit])).split('\0').filter(Boolean)
    for (const p of paths) {
      const why = p.startsWith(prefix) ? refusal(p.slice(prefix.length)) : `${p} is outside the site`
      if (why) throw new CheckoutError(`undoing ${commit.slice(0, 7)} would change ${p.slice(prefix.length)}: ${why}`)
    }

    const tmp = mkdtempSync(join(tmpdir(), 'basecamp-revert-'))
    try {
      const index = { GIT_INDEX_FILE: join(tmp, 'index') }
      await git(dir, ['read-tree', '-m', '-i', '--aggressive', commit, baseHead, parent], { env: index })
      const conflicted = await resolveBoth(dir, tmp, index)
      if (conflicted.length)
        throw new MergeConflict(`${conflicted.map(p => p.slice(prefix.length)).join(', ')} changed again since ${commit.slice(0, 7)} — a developer undoes it`, conflicted)
      const tree = (await git(dir, ['write-tree'], { env: index })).trim()
      if (tree === (await git(dir, ['rev-parse', `${baseHead}^{tree}`])).trim())
        throw new CheckoutError(`${base} already holds none of ${commit.slice(0, 7)}`)
      const who = {
        GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email,
      }
      const made = (await git(dir, ['commit-tree', tree, '-p', baseHead, '-F', '-'],
        { input: `${message}\n\nThis reverts ${commit}.\n`, env: who })).trim()
      await git(dir, ['push', '--quiet', 'origin', `${made}:refs/heads/${named.branch}`]).catch((err) => {
        throw new CheckoutError(`could not push ${named.branch}: ${err.message}`)
      })
      await git(dir, ['update-ref', `refs/remotes/origin/${named.branch}`, made])
      const at = (await git(dir, ['log', '-1', '--format=%cI', made])).trim()
      return { name: named.slug, branch: named.branch, head: made, at: new Date(at).toISOString(), author: author.name, subject: message }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
}

/** The site's branch for a release a developer starts, which drafts also start from. */
export function siteBranch(site: GitSite, root = sitesDir()): Promise<{ branch: string, head: string }> {
  return serial(site.id, async () => {
    const dir    = await synced(site, root)
    const branch = await baseBranch(site, dir)
    const head   = await headOf(dir, branch)
    if (!head) throw new CheckoutError(`${site.source.repo} has no branch ${branch}`)
    return { branch, head }
  })
}
