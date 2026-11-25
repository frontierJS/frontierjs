// src/errors.ts — GitHub's refusal → the app's answer. The one reader of
// `error.raw`, the status and the response headers (C3).
//
// Conduit grades every 401 and 403 `auth_failed`, never replays one and never
// counts one toward the breaker. GitHub answers a PRIMARY rate limit as a 403
// (not 429) with `x-ratelimit-remaining: 0` and no `retry-after`, and a
// secondary limit as a 403 or 429 whose message says so. Left alone, a busy
// token reads to the app as "give it Administration › Read and write". A grant
// the token lacks is the same 403 with `x-ratelimit-remaining` above zero, so
// the header is what tells the two apart, and this is the one place that reads it.

import { errorBody, type ConduitError } from '@frontierjs/conduit'
import type { GithubErrorBody, Grant } from './types.ts'

export type GithubFailureKind =
  | 'refused_grant' // a 403 that is NOT a limit: the token lacks `grant` on this repository
  | 'unseen'        // a 404: no such repository or file, or the token was not given it — never says which
  | 'key_in_use'    // a 422: this deploy key is already on a repository; GitHub allows one across all of it
  | 'refused'       // another 4xx: the request itself was wrong
  | ConduitError['kind']

export interface GithubFailure {
  kind:           GithubFailureKind
  message:        string
  retryable:      boolean
  /** Set where the request left and its outcome is unknown: the caller reads before writing again (C6). */
  indeterminate?: boolean
  /** On `refused_grant`: the grant the call needs, as GitHub's token settings name it. */
  grant?:         Grant
  /** On `refused_grant`: the level to set it to. */
  level?:         string
  /** On `rate_limited`: how long to wait, from `retry-after`, else the reset, else a minute. */
  retryAfterMs?:  number
}

/** The level each grant is set to on the token's settings page for the calls this package makes. */
export const GRANT_LEVEL: Record<Grant, string> = {
  Administration: 'Read and write',
  Webhooks:       'Read and write',
  Contents:       'Read-only',
  Metadata:       'Read-only',
}

/** GitHub's own advice when a limit names no wait. */
export const DEFAULT_WAIT_MS = 60_000

const SECONDARY = /secondary rate limit|abuse detection/i

const seconds = (v: string | undefined): number | undefined => {
  if (v === undefined || v.trim() === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/** How long a limit says to wait: `retry-after`, else the reset (epoch seconds), else a minute. */
function waitMs(error: ConduitError, headers: Record<string, string> | undefined, now: number): number {
  const after = seconds(headers?.['retry-after'])
  if (after !== undefined) return Math.max(0, Math.ceil(after * 1000))
  if (error.retry_after_ms !== undefined) return error.retry_after_ms
  const reset = seconds(headers?.['x-ratelimit-reset'])
  // A reset already past would read as no wait at all, which is a replay the limit has not lifted.
  if (reset !== undefined) return Math.max(1000, Math.ceil(reset * 1000 - now))
  return DEFAULT_WAIT_MS
}

/**
 * `grant` is the one the call needs, so a 403 names it; `now` is the clock the
 * reset is measured from, an argument so a test can move it.
 */
export function translate(
  error: ConduitError, status?: number, headers?: Record<string, string>,
  opts: { grant?: Grant; now?: number } = {},
): GithubFailure {
  const body = errorBody<GithubErrorBody>(error.raw)
  const said = body?.message
  const detail = body?.errors?.find(e => e?.message)?.message
  const base: GithubFailure = {
    kind:      error.kind,
    message:   [said, detail].filter((s, i, all) => s && all.indexOf(s) === i).join(' — ') || error.message,
    retryable: error.retryable,
    ...(error.indeterminate ? { indeterminate: true } : {}),
  }

  const exhausted = seconds(headers?.['x-ratelimit-remaining']) === 0
  const asked     = headers?.['retry-after'] !== undefined
  const limited   = (status === 403 || status === 429) && (exhausted || asked || SECONDARY.test(said ?? ''))
  if (limited || status === 429) return { ...base, kind: 'rate_limited', retryable: true, retryAfterMs: waitMs(error, headers, opts.now ?? Date.now()) }

  if (status === 401) return { ...base, kind: 'auth_failed', retryable: false }
  if (status === 403) {
    const grant = opts.grant
    return { ...base, kind: 'refused_grant', retryable: false, ...(grant ? { grant, level: GRANT_LEVEL[grant] } : {}) }
  }
  if (status === 404) return { ...base, kind: 'unseen', retryable: false }
  if (status === 422 && /already in use/i.test(detail ?? said ?? '')) return { ...base, kind: 'key_in_use', retryable: false }
  if (error.kind === 'client_error') return { ...base, kind: 'refused', retryable: false }
  return base
}
