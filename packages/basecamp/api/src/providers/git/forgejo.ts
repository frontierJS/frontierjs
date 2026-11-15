// src/providers/git/forgejo.ts
// Forgejo's `/api/v1` dialect for `IGit`, and the only file in this app that
// knows it. It reads and never writes: the push hook is pasted into the forge by
// hand from the Deploy on push card (`FJS-D1370`), so a hook registered here
// would be a second one firing every release twice.
//
// It speaks through an `AccountSend`, the shape `source/github.ts` takes, so the
// token and the timeout belong to the transport and the dialect is graded
// against a hand-written send.

import type { AccountSend }  from '../compute/index.ts'
import type { IGit, GitRepo, GitPullRequest, CiVerdict } from '../../basecamp.types.ts'

/** Forgejo's largest page. */
const LIMIT = 50

/** A listing stops here. A forge with more than a thousand repositories, or a
 *  repository with that many open pull requests, is not one a table can show,
 *  and an unbounded loop is what a forge that ignores `page` would cost. */
const MAX_PAGES = 20

/** Status reads in flight at once: a listing asks one per repository, and a
 *  forge on a small box answers a burst of hundreds as a stall. */
const IN_FLIGHT = 8

type Row = Record<string, unknown>

const str  = (v: unknown): string => typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
const num  = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) ? v : 0
const list = (data: unknown): Row[] => Array.isArray(data) ? data as Row[] : []

/**
 * The combined status's `state` as a verdict. `''` is a commit no status was
 * ever reported for — a forge with no CI — and reads `unknown`, never
 * `pending`, which would say a run is coming.
 */
export function ciVerdict(state: unknown): CiVerdict {
  switch (state) {
    case 'success':  return 'passing'
    case 'failure':
    case 'error':    return 'failing'
    case 'pending':
    case 'warning':  return 'pending'
    default:         return 'unknown'
  }
}

/** `owner/name` — the name `listRepos` answers, which is the one
 *  `listPullRequests` takes back. */
function repoPath(repo: string): string {
  const [owner, name, ...rest] = repo.split('/')
  if (!owner || !name || rest.length)
    throw new Error(`Forgejo: '${repo}' is not owner/name — a repository is named with its owner`)
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
}

/**
 * A throw saying in Forgejo's terms why there is no answer. A screen showing
 * `client_error (HTTP 401)` does not tell an operator the token was revoked.
 */
function refusal(res: Awaited<ReturnType<AccountSend>>, path: string): never {
  const said = str((res.data as Row | null)?.message)
  if (res.status === 401)
    throw new Error('Forgejo refused the token — it was revoked or has expired; mint a new one')
  if (res.status === 403)
    throw new Error(`Forgejo: the token may not read ${path} — give it the read:repository scope${said ? ` (${said})` : ''}`)
  if (res.status === 404)
    throw new Error(`Forgejo: ${path} was not found, or the token cannot see it`)
  throw new Error(`Forgejo: ${res.error?.kind ?? 'error'}${res.status ? ` (HTTP ${res.status})` : ''}${said ? ` — ${said}` : ''}`)
}

async function pooled<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]!) } }
  await Promise.all(Array.from({ length: Math.min(IN_FLIGHT, items.length) }, worker))
  return out
}

export class ForgejoGit implements IGit {
  constructor(private readonly send: AccountSend) {}

  private async get(path: string): Promise<unknown> {
    const res = await this.send({ method: 'GET', path })
    if (res.error) refusal(res, path)
    return res.data
  }

  /** Every page, in order. A page shorter than the limit is the last; the
   *  answer carries no `X-Total-Count` through a send. */
  private async all(path: string): Promise<Row[]> {
    const rows: Row[] = []
    const sep = path.includes('?') ? '&' : '?'
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = list(await this.get(`${path}${sep}page=${page}&limit=${LIMIT}`))
      rows.push(...batch)
      if (batch.length < LIMIT) break
    }
    return rows
  }

  /** The verdict on one ref. A ref the forge does not have — an empty
   *  repository's default branch — has had no CI either. */
  private async verdict(repoPathname: string, ref: string): Promise<CiVerdict> {
    if (!ref) return 'unknown'
    const res = await this.send({ method: 'GET', path: `${repoPathname}/commits/${encodeURIComponent(ref)}/status` })
    if (res.error && res.status === 404) return 'unknown'
    if (res.error) refusal(res, `${repoPathname}/commits/${ref}/status`)
    return ciVerdict((res.data as Row | null)?.state)
  }

  async listRepos(): Promise<GitRepo[]> {
    const rows = await this.all('/user/repos')
    return pooled(rows, async (r): Promise<GitRepo> => {
      const fullName      = str(r.full_name) || `${str((r.owner as Row | undefined)?.login)}/${str(r.name)}`
      const defaultBranch = str(r.default_branch)
      return {
        name:             fullName,
        clone_url:        str(r.clone_url),
        ...(str(r.description) ? { description: str(r.description) } : {}),
        ...(defaultBranch ? { defaultBranch } : {}),
        ci:               r.empty === true ? 'unknown' : await this.verdict(repoPath(fullName), defaultBranch),
        openPullRequests: num(r.open_pr_counter),
        openIssues:       num(r.open_issues_count),
        // Forgejo records no push time; `updated_at` moves on a push and on
        // a settings change, which is the nearer of the two to *last pushed*.
        ...(str(r.updated_at) ? { lastPushedAt: str(r.updated_at) } : {}),
      }
    })
  }

  async listPullRequests(repo: string): Promise<GitPullRequest[]> {
    const path = repoPath(repo)
    const rows = await this.all(`${path}/pulls?state=open`)
    return pooled(rows, async (p): Promise<GitPullRequest> => {
      const head = (p.head ?? {}) as Row
      return {
        number:    num(p.number),
        title:     str(p.title),
        author:    str((p.user as Row | undefined)?.login),
        branch:    str(head.ref),
        ci:        await this.verdict(path, str(head.sha)),
        mergeable: p.mergeable === true,
        openedAt:  str(p.created_at),
      }
    })
  }

  // Listing only. Each refuses by name rather than answering empty: an empty
  // answer from a write reads as done.
  async createRepo(name: string): Promise<{ id: number; clone_url: string }> {
    throw new Error(`ForgejoGit.createRepo(${name}): not built — this provider lists; create the repository at the forge`)
  }

  async deleteRepo(name: string): Promise<void> {
    throw new Error(`ForgejoGit.deleteRepo(${name}): not built — this provider lists; delete the repository at the forge`)
  }

  async createWebhook(repo: string): Promise<{ id: number }> {
    throw new Error(`ForgejoGit.createWebhook(${repo}): refused — the push hook is pasted into the forge from the Deploy on push card (FJS-D1370)`)
  }
}
