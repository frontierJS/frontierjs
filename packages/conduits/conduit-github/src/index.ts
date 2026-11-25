// @frontierjs/conduit-github — GitHub's REST dialect over conduit.
//
// What stays in an app: `AccountSend`, the repository-unseen type, the sentences a screen
// shows for a missing grant, and git's own credential path (`gitCredential`,
// FJS-D2108), which is not a REST call.
//
// Auth is a fine-grained personal access token (FJS-D1571), a `bearer` target,
// and each call needs one grant on the repository: a deploy key is
// Administration write, a hook is Webhooks write, a file is Contents read.
//
// No write here takes an idempotency key — GitHub collapses none (C5). A deploy
// key and a hook are created unkeyed, and a lost answer is resolved by the list
// read that finds what the write left (C6): keys by their material, hooks by
// their URL.

import type { ConduitError, ConduitRequest, ConduitResult, TargetDescriptor } from '@frontierjs/conduit'
import { translate, type GithubFailure } from './errors.ts'
import type { DeployKey, GithubRepo, GithubRepository, Grant, PushHook } from './types.ts'

export * from './types.ts'
export * from './errors.ts'
export * from './verify.ts'

export const GITHUB_ADDRESS = 'https://api.github.com'

/** The REST version every call is pinned to; unpinned, GitHub answers in whatever it defaults to that year. */
export const GITHUB_API_VERSION = '2022-11-28'

/** A list is read at its largest page. A repository with more keys or hooks than
 *  this is not one this connector wrote most of, and a key past the page is
 *  added again and refused by name as in use. */
const PER_PAGE = 100

/** A file over this arrives with no content (the contents API's own limit). */
export const MAX_FILE_BYTES = 1_000_000

export type Send = <T>(req: Omit<ConduitRequest, 'target'>) => Promise<ConduitResult<T>>
export function bindSend(conduit: { send<T>(req: ConduitRequest): Promise<ConduitResult<T>> }, target: string): Send {
  return req => conduit.send({ target, ...req })
}

/**
 * One target per ACCOUNT when `accountId` is given (`provider:github:<id>`): a
 * token is a workspace's. Without it, one per process (`provider:github`).
 * GitHub refuses a request with no User-Agent, so `userAgent` is required and
 * an empty one is refused here rather than at the first 403.
 */
export function githubTarget(opts: { ref: string; userAgent: string; accountId?: string; address?: string; perCaller?: boolean }): TargetDescriptor {
  if (!opts.userAgent?.trim()) throw new Error('githubTarget: userAgent is required — GitHub refuses a request that names no caller')
  return {
    id:            opts.accountId ? `provider:github:${opts.accountId}` : 'provider:github',
    kind:          'provider',
    protocol:      'http',
    address:       (opts.address ?? GITHUB_ADDRESS).replace(/\/$/, ''),
    auth:          { type: 'bearer', ref: opts.ref, ...(opts.perCaller ? { per_caller: true as const } : {}) },
    headers:       {
      'accept':               'application/vnd.github+json',
      'x-github-api-version': GITHUB_API_VERSION,
      'user-agent':           opts.userAgent.trim(),
    },
    registered_at: Date.now(),
    last_seen_at:  null,
  } as TargetDescriptor
}

export class GithubError extends Error {
  constructor(public failure: GithubFailure) {
    super(`GitHub: ${failure.kind}${failure.grant ? ` (needs ${failure.grant} › ${failure.level})` : ''} — ${failure.message}`)
  }
}

type Row = Record<string, unknown>
const str = (v: unknown): string => typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
const list = (data: unknown): Row[] => Array.isArray(data) ? data as Row[] : []

const repoPath = (r: GithubRepo) => `/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.name)}`
const failure = (r: { error: ConduitError; meta: { status?: number; headers?: Record<string, string> } }, grant?: Grant) =>
  translate(r.error, r.meta.status, r.meta.headers, grant ? { grant } : {})

/** The answer's body, or a throw saying in GitHub's terms why there is none. */
async function call<T>(send: Send, req: Omit<ConduitRequest, 'target'>, grant: Grant): Promise<T> {
  const r = await send<T>(req)
  if (r.error) throw new GithubError(failure(r, grant))
  return r.data
}

/** `<type> <base64>`: GitHub drops the comment from a key it stores, so two spellings of one key compare equal only without it. */
export const material = (key: string) => key.trim().split(/\s+/).slice(0, 2).join(' ')

const toKey = (k: Row): DeployKey => ({ id: str(k.id), title: str(k.title), key: str(k.key), readOnly: k.read_only === true })

const toHook = (h: Row): PushHook => {
  const config = (h.config ?? {}) as Row
  return { id: str(h.id), url: str(config.url), events: Array.isArray(h.events) ? (h.events as unknown[]).map(str) : [], active: h.active === true }
}

/** Is this token live? `/user` needs no grant, so a token given no repository verifies here and is refused by name at the call that names one.
 *  A 401 or a refusal is GitHub saying no to THIS token; a limit, a 5xx or a lost connection is not knowing, and must not mark a working token broken. */
export async function verify(send: Send): Promise<boolean> {
  const r = await send<Row | null>({ method: 'GET', path: '/user' })
  if (r.error) {
    const f = failure(r)
    if (f.kind === 'auth_failed' || f.kind === 'refused_grant') return false
    throw new GithubError(f)
  }
  return Boolean(r.data?.login)
}

async function readRepository(send: Send, repo: GithubRepo, grant: Grant): Promise<GithubRepository> {
  const r = await call<Row>(send, { method: 'GET', path: repoPath(repo) }, grant)
  return { fullName: str(r?.full_name), private: r?.private === true, defaultBranch: str(r?.default_branch) }
}

/** Does the token see this repository? A refusal is `unseen`: a repository that does not exist and one the token was not given both answer 404. */
export const repository = (send: Send, repo: GithubRepo): Promise<GithubRepository> => readRepository(send, repo, 'Metadata')

const keysOf = async (send: Send, repo: GithubRepo): Promise<DeployKey[]> =>
  list(await call<unknown>(send, { method: 'GET', path: `${repoPath(repo)}/keys?per_page=${PER_PAGE}` }, 'Administration')).map(toKey)

const hooksOf = async (send: Send, repo: GithubRepo): Promise<PushHook[]> =>
  list(await call<unknown>(send, { method: 'GET', path: `${repoPath(repo)}/hooks?per_page=${PER_PAGE}` }, 'Webhooks')).map(toHook)

/** The write's answer was lost: the request may have applied, so the list read says. */
const lost = (e: unknown): boolean => e instanceof GithubError && e.failure.indeterminate === true

/**
 * The key by its material, created read-only if absent. GitHub allows a deploy
 * key on one repository across all of GitHub, so a key already on another
 * answers `key_in_use`. A create whose answer was lost is resolved by the list.
 */
export async function setDeployKey(send: Send, repo: GithubRepo, { title, key }: { title: string; key: string }): Promise<DeployKey> {
  const want = material(key)
  const find = async () => (await keysOf(send, repo)).find(k => material(k.key) === want)
  const have = await find()
  if (have) return have
  try {
    return toKey(await call<Row>(send, { method: 'POST', path: `${repoPath(repo)}/keys`, body: { title, key: want, read_only: true } }, 'Administration') ?? {})
  } catch (e) {
    if (!lost(e)) throw e
    const landed = await find()
    if (landed) return landed
    throw e
  }
}

/** The body a push hook is written with. `content_type: json` because a receiver reads a JSON body, and the form encoding signs the same bytes but delivers them as `payload=`. */
const hookBody = (url: string, secret: string) => ({
  active: true,
  events: ['push'],
  config: { url, content_type: 'json', secret, insecure_ssl: '0' },
})

/**
 * The hook for `url`, found by URL and rewritten (`PATCH`) or created (`POST`).
 * The secret is only ever written: GitHub answers it masked, so no read can say
 * whether a stored secret is current, and the hook is rewritten every time.
 * A create whose answer was lost is resolved by the list; a lost rewrite is
 * safe to repeat.
 */
export async function setPushHook(send: Send, repo: GithubRepo, { url, secret }: { url: string; secret: string }): Promise<PushHook> {
  const path = `${repoPath(repo)}/hooks`
  const have = (await hooksOf(send, repo)).find(h => h.url === url)
  if (have) return toHook(await call<Row>(send, { method: 'PATCH', path: `${path}/${encodeURIComponent(have.id)}`, body: hookBody(url, secret) }, 'Webhooks') ?? {})
  try {
    return toHook(await call<Row>(send, { method: 'POST', path, body: { name: 'web', ...hookBody(url, secret) } }, 'Webhooks') ?? {})
  } catch (e) {
    if (!lost(e)) throw e
    const landed = (await hooksOf(send, repo)).find(h => h.url === url)
    if (landed) return landed
    throw e
  }
}

/**
 * The first of `paths` that is a file, or null. The repository is asked for
 * first, so a missing FILE is never read as an unseen REPOSITORY: both answer
 * 404. A directory answers a list and a file over 1 MB answers no content;
 * both are skipped as not there.
 */
export async function readFile(send: Send, repo: GithubRepo, { paths, ref }: { paths: string[]; ref?: string }): Promise<{ path: string; content: string } | null> {
  await readRepository(send, repo, 'Contents')
  const at = ref ? `?ref=${encodeURIComponent(ref)}` : ''
  for (const path of paths) {
    const r = await send<Row | Row[]>({ method: 'GET', path: `${repoPath(repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}${at}` })
    if (r.error) {
      if (r.meta.status === 404) continue
      throw new GithubError(failure(r, 'Contents'))
    }
    const file = r.data as Row | null
    if (!file || Array.isArray(file) || file.type !== 'file' || file.encoding !== 'base64') continue
    return { path, content: Buffer.from(str(file.content), 'base64').toString('utf8') }
  }
  return null
}
