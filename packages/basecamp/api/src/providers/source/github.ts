// src/providers/source/github.ts
// GitHub's dialect, and the only file in this app that knows it.
//
// The token is a fine-grained personal access token (`FJS-D1571`), and each
// call needs one grant on the repository: a deploy key is Administration
// write, a webhook is Webhooks write, a file is Contents read. GitHub answers a
// repository the token was not given as 404, the same as one that does not
// exist, so a 404 here names both — and a missing FILE is a 404 too, which is
// why `readFile` asks for the repository before its paths.
//
// ─── A deploy key is unique across GitHub ────────────────────────────────
//
// One public key may be a deploy key on one repository only; a second answers
// 422 *key is already in use*. An App's key is its own, so this is an App moved
// to another repository with its old key still on the first — the refusal says
// to remove it there.

import { env }                    from '../../core/env.ts'
import { targetFor }              from '../compute/index.ts'
import type { TargetDescriptor }  from '@frontierjs/conduit'
import type { AccountSend }       from '../compute/index.ts'
import { RepoUnseen }             from './index.ts'
import type { SourceConnector, SourceRepo, DeployKey, PushHook } from './index.ts'

/** Where GitHub is. Overridden by `GITHUB_URL` for the dev sink. */
const GH_API = 'https://api.github.com'

/** The REST version every call is pinned to; unpinned, GitHub answers in
 *  whatever it defaults to that year. */
const API_VERSION = '2022-11-28'

/** A list is read at its largest page. A repository with more deploy keys or
 *  hooks than this is not one this app wrote most of, and a key past the page
 *  is added again and refused by name as in use. */
const PER_PAGE = 100

type Row = Record<string, unknown>

const str = (v: unknown): string => typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''

const repoPath = (r: SourceRepo) => `/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.name)}`

/** `<type> <base64>`: GitHub drops the comment from a key it stores, so two
 *  spellings of one key compare equal only without it. */
const material = (key: string) => key.trim().split(/\s+/).slice(0, 2).join(' ')

/** What the grant a call needs is called on the token's settings page, and
 *  the level it is set to there. */
type Grant = 'Administration' | 'Webhooks' | 'Contents'
const LEVEL: Record<Grant, string> = { Administration: 'Read and write', Webhooks: 'Read and write', Contents: 'Read-only' }

/**
 * The answer's body, or a throw saying in GitHub's terms why there is none.
 * The cause is the whole message: a connect that fails on screen as
 * `client_error (HTTP 403)` tells an operator nothing about which grant the
 * token is missing.
 */
function unwrap(res: Awaited<ReturnType<AccountSend>>, repo: SourceRepo, grant: Grant): unknown {
  if (!res.error) return res.data
  const body   = (res.data ?? {}) as Row
  const said   = str(body.message)
  const detail = Array.isArray(body.errors) ? str((body.errors as Row[])[0]?.message) : ''
  const where  = `${repo.owner}/${repo.name}`

  if (res.status === 401)
    throw new Error('GitHub refused the token — it was revoked or has expired; paste a new one on the account')
  if (res.status === 403)
    throw new Error(`GitHub: the token may not do this on ${where} — give it ${grant} › ${LEVEL[grant]}`
      + `${said ? ` (${said})` : ''}`)
  if (res.status === 404)
    throw new RepoUnseen(`GitHub: ${where} was not found, or the token was not given it`)
  if (res.status === 422 && /already in use/i.test(detail))
    throw new Error(`GitHub: this App's deploy key is already on another repository — GitHub allows one; remove it there`)
  throw new Error(`GitHub: ${res.error.kind}${res.status ? ` (HTTP ${res.status})` : ''}`
    + `${detail || said ? ` — ${detail || said}` : ''}`)
}

const list = (data: unknown): Row[] => Array.isArray(data) ? data as Row[] : []

function toKey(k: Row): DeployKey {
  return { id: str(k.id), title: str(k.title), key: str(k.key), readOnly: k.read_only === true }
}

function toHook(h: Row): PushHook {
  const config = (h.config ?? {}) as Row
  return {
    id:     str(h.id),
    url:    str(config.url),
    events: Array.isArray(h.events) ? (h.events as unknown[]).map(str) : [],
    active: h.active === true,
  }
}

/** The body a push hook is written with. `content_type: json` because
 *  `plugins/push.ts` reads a JSON body, and the form encoding signs the same
 *  bytes but delivers them as `payload=`. */
function hookBody(url: string, secret: string) {
  return {
    active: true,
    events: ['push'],
    config: { url, content_type: 'json', secret, insecure_ssl: '0' },
  }
}

export const github: SourceConnector = {
  kind:  'github',
  label: 'GitHub',

  // A getter, for digitalocean.ts's reason: a value is captured at import and a
  // test pointing this at a stand-in afterwards would reach the real vendor.
  get address() { return env.GITHUB_URL || GH_API },

  descriptor({ accountId, ref, address }): TargetDescriptor {
    return {
      id:            targetFor('github', accountId),
      kind:          'provider',
      protocol:      'http',
      address:       address || github.address,
      auth:          { type: 'bearer', ref },
      // GitHub refuses a request with no User-Agent.
      headers:       {
        'accept':               'application/vnd.github+json',
        'x-github-api-version': API_VERSION,
        'user-agent':           'basecamp',
      },
      registered_at: Date.now(),
      last_seen_at:  null,
    } as TargetDescriptor
  },

  async verify(send): Promise<boolean> {
    // `/user` needs no grant, so it says the token is live and nothing about
    // which repositories it opens — a token given none verifies here and is
    // refused by name at the connect that names one.
    const res = await send({ method: 'GET', path: '/user' })
    if (res.error) {
      if (res.status && res.status < 500) return false
      throw new Error(`GitHub: ${res.error.kind}`)
    }
    return Boolean((res.data as Row | null)?.login)
  },

  async setDeployKey(send, repo, { title, key }): Promise<DeployKey> {
    const path = `${repoPath(repo)}/keys`
    const want = material(key)
    const have = list(unwrap(await send({ method: 'GET', path: `${path}?per_page=${PER_PAGE}` }), repo, 'Administration'))
      .map(toKey).find(k => material(k.key) === want)
    if (have) return have
    const made = unwrap(await send({ method: 'POST', path, body: { title, key: want, read_only: true } }), repo, 'Administration')
    return toKey((made ?? {}) as Row)
  },

  async readFile(send, repo, { paths, ref }): Promise<{ path: string; content: string } | null> {
    unwrap(await send({ method: 'GET', path: repoPath(repo) }), repo, 'Contents')
    const at = ref ? `?ref=${encodeURIComponent(ref)}` : ''
    for (const path of paths) {
      const res = await send({ method: 'GET', path: `${repoPath(repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}${at}` })
      if (res.status === 404) continue
      // A directory answers a list, and a file over 1 MB answers no content.
      const file = unwrap(res, repo, 'Contents') as Row | null
      if (file?.type !== 'file' || file.encoding !== 'base64') continue
      return { path, content: Buffer.from(str(file.content), 'base64').toString('utf8') }
    }
    return null
  },

  async setPushHook(send, repo, { url, secret }): Promise<PushHook> {
    const path = `${repoPath(repo)}/hooks`
    const have = list(unwrap(await send({ method: 'GET', path: `${path}?per_page=${PER_PAGE}` }), repo, 'Webhooks'))
      .map(toHook).find(h => h.url === url)
    const res = have
      ? await send({ method: 'PATCH', path: `${path}/${encodeURIComponent(have.id)}`, body: hookBody(url, secret) })
      : await send({ method: 'POST',  path, body: { name: 'web', ...hookBody(url, secret) } })
    return toHook((unwrap(res, repo, 'Webhooks') ?? {}) as Row)
  },
}
