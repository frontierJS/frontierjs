// src/domain/claude/claude-quota.ts — how much of the account's Claude limits are used.
//
// `GET api.anthropic.com/api/oauth/usage` with the OAuth token Claude Code
// keeps in `<configDir>/.credentials.json`: a private endpoint (`FJS-D1711`),
// so a failed read is *unavailable* with its reason and never a made-up bar.
//
// **The token is read, never refreshed.** The refresh token rotates: refreshing
// it here would invalidate the one every running `claude` holds and sign them
// all out. An expired access token is therefore a refusal that says so — the
// next `claude` run refreshes it. The token stays inside this file: not in a
// return value, an error message or a log line.
//
// **The endpoint shares the account's rate limit with every running `claude`.**
// A 429 stops reads for the longer of `Retry-After` and a step that climbs
// 5, 10, 20, 30 minutes on consecutive 429s and resets on a success. While
// stopped the last good read is served marked `stale`, with `retryAt`; a
// forced refresh does NOT skip the stop. A good read is cached for 60 s so a
// screen refresh does not reach the endpoint at all.
//
// The response carries a fixed few windows (`five_hour`, `seven_day`) and a
// `limits` list whose `weekly_scoped` entries name a model (`Fable`, `Sonnet`)
// by display name. Per-model weeklies are therefore a list of
// `{ label, ... }`, not named fields: which models are limited is the
// account's, and a new one must not need a code change. `five_hour` is `null`
// while no session window is open, which is a state and not a failure.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { read, readJsonObject, unreadable, type Read } from './claude-read.ts'
import { claudeConfigDir } from './claude-scan.ts'

export type Meter = {
  /** Percent of the limit used, 0 to 100 (and above when over). */
  utilization: number
  resetsAt:    string | null
}

export type ModelMeter = Meter & {
  /** The model's display name as the endpoint gives it: `Fable`, `Sonnet`. */
  label:  string
  /** Whether this limit is the one currently binding, as the endpoint reports it; null when it does not say. */
  active: boolean | null
}

export type Quota = {
  /** The 5-hour window; null while none is open. */
  session: Meter | null
  weekly:  Meter | null
  models:  ModelMeter[]
}

/** A Quota as served: stale when the endpoint is stopped and this is the last good read. */
export type QuotaRead = Quota & {
  fetchedAt: string
  stale:     boolean
  /** Set when stale: the earliest time a read will reach the endpoint again. */
  retryAt:   string | null
}

// ─── the pure half ────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function meterOf(v: unknown): Meter | null {
  if (!isObj(v) || typeof v.utilization !== 'number') return null
  return { utilization: v.utilization, resetsAt: typeof v.resets_at === 'string' ? v.resets_at : null }
}

/** The usage response as a Quota. Unknown keys are ignored: the endpoint adds codenamed ones. */
export function readUsage(json: unknown): Read<Quota> {
  if (!isObj(json)) return unreadable('usage response is not a JSON object')
  if (!('seven_day' in json) && !('five_hour' in json) && !Array.isArray(json.limits)) {
    return unreadable('usage response names no windows (no five_hour, seven_day or limits)')
  }
  const limits = Array.isArray(json.limits) ? json.limits.filter(isObj) : []
  const limitMeter = (l: Record<string, unknown>): Meter | null =>
    typeof l.percent === 'number' ? { utilization: l.percent, resetsAt: typeof l.resets_at === 'string' ? l.resets_at : null } : null

  const session = meterOf(json.five_hour)
    ?? limits.filter(l => l.group === 'session' || l.kind === 'session').map(limitMeter).find(Boolean) ?? null
  const weekly = meterOf(json.seven_day)
    ?? limits.filter(l => l.kind === 'weekly_all').map(limitMeter).find(Boolean) ?? null

  const models: ModelMeter[] = []
  for (const l of limits) {
    if (l.kind !== 'weekly_scoped') continue
    const scope = isObj(l.scope) && isObj(l.scope.model) ? l.scope.model : null
    const label = scope && typeof scope.display_name === 'string' ? scope.display_name : null
    const meter = limitMeter(l)
    if (!label || !meter) continue
    models.push({ label, ...meter, active: typeof l.is_active === 'boolean' ? l.is_active : null })
  }
  // The older fixed keys, for a response that has no `limits` or omits a model from it.
  for (const [key, label] of [['seven_day_opus', 'Opus'], ['seven_day_sonnet', 'Sonnet']] as const) {
    const meter = meterOf(json[key])
    if (meter && !models.some(m => m.label === label)) models.push({ label, ...meter, active: null })
  }
  return read({ session, weekly, models })
}

// ─── the token ────────────────────────────────────────────────────────────────

/** The access token, or why there is none. The only function that handles it. */
function accessToken(configDir: string, now: number): Read<string> {
  let text: string
  try { text = readFileSync(join(configDir, '.credentials.json'), 'utf8') }
  catch { return unreadable('no .credentials.json under the Claude config folder (not logged in, or the login lives in the OS keychain)') }
  const json = readJsonObject(text)
  if (!json.ok) return unreadable('.credentials.json is not readable JSON')
  const oauth = json.value.claudeAiOauth
  if (!isObj(oauth) || typeof oauth.accessToken !== 'string' || !oauth.accessToken) {
    return unreadable('.credentials.json holds no claude.ai login (an API-key login has no quota)')
  }
  // A token inside its last half minute would expire in flight.
  if (typeof oauth.expiresAt === 'number' && oauth.expiresAt - 30_000 <= now) {
    return unreadable('token expired, run claude to refresh')
  }
  return read(oauth.accessToken)
}

// ─── the stop and the cache ───────────────────────────────────────────────────

const URL_USAGE   = 'https://api.anthropic.com/api/oauth/usage'
const CACHE_MS    = 60_000
const TIMEOUT_MS  = 10_000
const STEPS_MIN   = [5, 10, 20, 30]

const state: { good: QuotaRead | null, goodAt: number, stopUntil: number, strikes: number } =
  { good: null, goodAt: 0, stopUntil: 0, strikes: 0 }

/** Forget the cache and the stop. For a test; nothing in the app calls it. */
export function resetQuotaState(): void {
  state.good = null; state.goodAt = 0; state.stopUntil = 0; state.strikes = 0
}

/** `Retry-After` as ms: delta-seconds or an HTTP date. 0 when absent or unreadable. */
function retryAfterMs(header: string | null, now: number): number {
  if (!header) return 0
  const secs = Number(header)
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000)
  const at = Date.parse(header)
  return Number.isFinite(at) ? Math.max(0, at - now) : 0
}

export type FetchUsageOptions = {
  /** Bypasses the 60 s cache. Does not bypass a 429 stop. */
  force?:     boolean
  configDir?: string
  now?:       number
  fetch?:     typeof fetch
}

function stale(retryAt: number): Read<QuotaRead> | null {
  if (!state.good) return null
  return read({ ...state.good, stale: true, retryAt: new Date(retryAt).toISOString() })
}

/** The account's quotas. Never throws; the token is never in what it returns. */
export async function fetchUsage(opts: FetchUsageOptions = {}): Promise<Read<QuotaRead>> {
  const now = opts.now ?? Date.now()

  if (now < state.stopUntil) {
    return stale(state.stopUntil)
      ?? unreadable(`rate limited by the usage endpoint; next read at ${new Date(state.stopUntil).toISOString()}`)
  }
  if (!opts.force && state.good && now - state.goodAt < CACHE_MS) return read(state.good)

  const configDir = claudeConfigDir({ configDir: opts.configDir })
  const token = accessToken(configDir, now)
  if (!token.ok) return unreadable(token.reason)

  let res: Response
  try {
    res = await (opts.fetch ?? fetch)(URL_USAGE, {
      headers: { Authorization: `Bearer ${token.value}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' },
      signal:  AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    // The message of a fetch failure names a host, not a header; the name alone is enough and safest.
    return unreadable(`usage endpoint unreachable (${(e as Error).name})`)
  }

  if (res.status === 429) {
    const step = STEPS_MIN[Math.min(state.strikes, STEPS_MIN.length - 1)] * 60_000
    state.strikes += 1
    state.stopUntil = now + Math.max(retryAfterMs(res.headers.get('retry-after'), now), step)
    return stale(state.stopUntil)
      ?? unreadable(`rate limited by the usage endpoint; next read at ${new Date(state.stopUntil).toISOString()}`)
  }
  if (res.status === 401 || res.status === 403) return unreadable(`usage endpoint refused the login (${res.status}); run claude to refresh it`)
  if (!res.ok) return unreadable(`usage endpoint answered ${res.status}`)

  let body: unknown
  try { body = await res.json() } catch { return unreadable('usage endpoint answered with text that is not JSON') }
  const quota = readUsage(body)
  if (!quota.ok) return unreadable(quota.reason)

  state.strikes = 0
  state.stopUntil = 0
  state.goodAt = now
  state.good = { ...quota.value, fetchedAt: new Date(now).toISOString(), stale: false, retryAt: null }
  return read(state.good)
}
