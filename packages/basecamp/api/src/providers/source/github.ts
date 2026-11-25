// src/providers/source/github.ts
// GitHub as Basecamp says it: an adapter over `@frontierjs/conduit-github`
// (`FJS-D2367`), which owns the REST dialect — the target's headers, the calls,
// and the one reading of a refusal (`translate`). What stays here is what a
// screen shows and what git does: the sentences each refusal reaches an
// operator as, `RepoUnseen`, and git's own credential path (`gitCredential`,
// `FJS-D2108`), which is not a REST call.
//
// A 403 is two things at GitHub: a grant the token lacks, and a rate limit
// (the primary limit answers 403, not 429). Read as one, a busy token tells an
// operator to change a grant that is already right, so a limit is its own
// sentence and says to wait.
//
// A deploy key is unique across GitHub: an App moved to another repository
// with its old key still on the first is refused by name, and the sentence
// says to remove it there.

import { env }                    from '../../core/env.ts'
import { createSecretResolver }   from '../../core/credentials.ts'
import { targetFor }              from '../compute/index.ts'
import type { ConduitResult }     from '@frontierjs/conduit'
import * as gh                    from '@frontierjs/conduit-github'
import type { AccountSend }       from '../compute/index.ts'
import { RepoUnseen }             from './index.ts'
import type { SourceConnector, SourceRepo } from './index.ts'
import type { App }               from '@frontierjs/junction'

/** Is this token live? One name here, so a rename in the connector is one line. */
const verifyToken = gh.verify

/** Basecamp's spend-guarded send, as the connector's `send`. On a refusal the
 *  account's `data` is the vendor's body, which is what `translate` reads when
 *  the error carries no `raw` of its own. */
function asSend(send: AccountSend): gh.Send {
  return async <T>(req: Parameters<gh.Send>[0]) => {
    const res = await send({
      method: req.method as Parameters<AccountSend>[0]['method'],
      path:   req.path ?? '',
      ...(req.body === undefined ? {} : { body: req.body }),
    })
    const meta = { status: res.status, headers: res.headers }
    if (!res.error) return { data: res.data, meta } as unknown as ConduitResult<T>
    const error = { retryable: false, ...res.error, raw: (res.error as { raw?: unknown }).raw ?? res.data }
    return { data: null, error, meta } as unknown as ConduitResult<T>
  }
}

const minutes = (ms: number) => {
  const m = Math.max(1, Math.ceil(ms / 60_000))
  return `${m} minute${m === 1 ? '' : 's'}`
}

/** The connector's refusal as the sentence a screen shows. Anything that is not
 *  a GitHub refusal (a guard, a bug) passes through as it was thrown. */
function said(err: unknown, repo?: SourceRepo): unknown {
  if (!(err instanceof gh.GithubError)) return err
  const f     = err.failure
  const where = repo ? `${repo.owner}/${repo.name}` : 'this repository'
  switch (f.kind) {
    case 'auth_failed':
      return new Error('GitHub refused the token — it was revoked or has expired; paste a new one on the account')
    case 'rate_limited':
      return new Error(`GitHub: this token is over GitHub's request limit — wait ${minutes(f.retryAfterMs ?? gh.DEFAULT_WAIT_MS)} and try again`)
    case 'refused_grant':
      return new Error(`GitHub: the token may not do this on ${where}`
        + `${f.grant ? ` — give it ${f.grant} › ${f.level}` : ''}${f.message ? ` (${f.message})` : ''}`)
    case 'unseen':
      return new RepoUnseen(`GitHub: ${where} was not found, or the token was not given it`)
    case 'key_in_use':
      return new Error(`GitHub: this App's deploy key is already on another repository — GitHub allows one; remove it there`)
    default:
      return new Error(`GitHub: ${f.kind}${f.message ? ` — ${f.message}` : ''}`)
  }
}

async function speak<T>(repo: SourceRepo | undefined, call: () => Promise<T>): Promise<T> {
  try { return await call() } catch (err) { throw said(err, repo) }
}

export const github: SourceConnector = {
  kind:  'github',
  label: 'GitHub',

  // A getter, for digitalocean.ts's reason: a value is captured at import and a
  // test pointing this at a stand-in afterwards would reach the real vendor.
  get address() { return env.GITHUB_URL || gh.GITHUB_ADDRESS },

  descriptor({ accountId, ref, address }) {
    return gh.githubTarget({ accountId, ref, address: address || github.address, userAgent: 'basecamp' })
  },

  verify: send => speak(undefined, () => verifyToken(asSend(send))),

  setDeployKey: (send, repo, key) => speak(repo, () => gh.setDeployKey(asSend(send), repo, key)),

  setPushHook: (send, repo, hook) => speak(repo, () => gh.setPushHook(asSend(send), repo, hook)),

  readFile: (send, repo, { paths, ref }) =>
    speak(repo, () => gh.readFile(asSend(send), repo, { paths, ...(ref ? { ref } : {}) })),
}

// ─── git over https ──────────────────────────────────────────────────────

const HTTPS_REPO = /^\/([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*?)(?:\.git)?\/?$/
const SSH_REPO   = /^(?:ssh:\/\/)?git@github\.com[:/]([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*?)(?:\.git)?\/?$/

/**
 * A GitHub repository as the https address Basecamp's own git calls use, or
 * null for any other remote. A private site's App stores the ssh form, because
 * the machine clones it with the App's deploy key; Basecamp holds no such key
 * and reaches the same repository over https with the workspace's token.
 */
export function githubHttps(repo: string): string | null {
  const r = repo.trim()
  const ssh = SSH_REPO.exec(r)
  if (ssh) return `https://github.com/${ssh[1]}/${ssh[2]}.git`
  let url: URL
  try { url = new URL(r) } catch { return null }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port) return null
  const named = HTTPS_REPO.exec(url.pathname)
  return named ? `https://github.com/${named[1]}/${named[2]}.git` : null
}

/** Git asks the helper for `get`; the token comes from the environment of the
 *  one call, so it is in no argv, no config file and no row. Matched to the URL
 *  `https://github.com` in the key, so a redirect to another host is offered no
 *  credential. */
const HELPER = '!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$FRONTIER_GIT_TOKEN"; }; f'
const HELPER_KEY = 'credential.https://github.com.helper'

/**
 * Environment entries that let one git call push to and fetch from a repository
 * as the workspace's GitHub account (`FJS-D2108`), or null where there is none:
 * the remote is not a GitHub repository (`githubHttps`), or no account sees it.
 * Null leaves git to the host's own credentials, which are none, so a public
 * repository still fetches and a private one is refused by name.
 *
 * Accounts are read as the system, scoped to the workspace: an editor holding a
 * grant on a site is not an administrator and cannot read a `Secret`, and the
 * grant is what authorizes the push. The token goes to git and nowhere else.
 * Only the repository's visibility is probed; whether the token may WRITE is
 * answered by the push, whose refusal names the grant.
 */
export async function gitCredential(
  app: App, { workspaceId, repo }: { workspaceId: string, repo: string },
): Promise<Record<string, string> | null> {
  const https = githubHttps(repo)
  if (!https) return null
  const [owner, name] = new URL(https).pathname.slice(1).replace(/\.git$/, '').split('/')
  const at: SourceRepo = { owner, name }

  // accounts.ts imports ./index.ts, which builds its connector table from this
  // file: a static import here evaluates that table before `github` exists.
  const { sendVia, tokenRef } = await import('../compute/accounts.ts')
  const db       = (app as unknown as { db: any }).db
  const accounts = await db.asSystem().secret.findMany({
    where:   { workspaceId, kind: 'providerKey', providerKind: 'github' },
    select:  { id: true },
    orderBy: { name: 'asc' },
  }) as { id: string }[]

  for (const a of accounts) {
    try {
      await github.readFile(sendVia(app, targetFor('github', a.id)), at, { paths: [] })
    } catch {
      // Unseen, revoked or unreachable: the next account may hold the grant.
      continue
    }
    const token = await createSecretResolver(db).get(tokenRef(a.id))
    if (typeof token !== 'string' || !token) continue
    return {
      GIT_CONFIG_COUNT:   '2',
      GIT_CONFIG_KEY_0:   HELPER_KEY, GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1:   HELPER_KEY, GIT_CONFIG_VALUE_1: HELPER,
      FRONTIER_GIT_TOKEN:      token,
    }
  }
  return null
}
