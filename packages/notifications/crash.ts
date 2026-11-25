import { dirname, join } from 'path'
import { hostname } from 'os'
import { readFileSync, writeFileSync } from 'fs'
import { ntfy } from './drivers/ntfy.ts'
import type { App, PushMessage } from './types.ts'

/**
 * The crash ping: one alert when the app dies of an uncaught throw (`FJS-D2184`
 * to `FJS-D2187`). junction owns the crash and announces `app:crash`, waiting
 * up to 3 s for its listeners before the drain; this file owns the send.
 *
 * ── Where it goes ───────────────────────────────────────────────────────
 * An app Basecamp deployed reports to Basecamp, which fans out to the channels
 * the operator picked (`FJS-D2272`, `FJS-D2358`). The ntfy trio is the
 * fallback for when Basecamp cannot take it, and the only destination for an
 * app with no Basecamp. A 429 is not a failure: Basecamp already holds the
 * crash loop, and a fallback push would page around its limit.
 *
 * ── Why a file and not memory or the database ───────────────────────────
 * `--restart unless-stopped` brings a crashed app straight back, so a counter
 * in memory pings once per restart and a crash loop rings all night. The
 * database is the likeliest thing to be broken when the app crashes, so the
 * window lives in a file beside it, which needs only a directory the app
 * already writes.
 */

export const CRASH_WINDOW_MS = 10 * 60_000
export const CRASH_RECORD_FILE = '.crash-ping'

interface CrashRecord {
  /** When the last ping left, in ms; 0 when none has. */
  pingedAt: number
  /** Crashes since then that sent nothing, suppressed or failed. */
  since:    number
}

/** Half of the 3 s hold, so a Basecamp that never answers leaves the trio
 *  time to send before junction drains. */
export const RELAY_TIMEOUT_MS = 1_500

export interface CrashRelay { base: string; endpoint: string }
export interface CrashTrio  { url: string; token?: string; topic: string }

export type CrashPingSettings =
  | { on: true;  relay?: CrashRelay; trio?: CrashTrio }
  | { on: false; missing: string[] }

/**
 * BASECAMP_URL and BASECAMP_APP_ID, which a Basecamp release sets together,
 * relay; NTFY_BASE_URL and NTFY_TOPIC send directly. Either pair alone is
 * enough, and a half-set pair is ignored rather than refusing boot: Basecamp
 * and Workbench set NTFY_BASE_URL for their own pushes and configure this
 * package.
 */
export function crashPingSettings(env: Record<string, string | undefined>): CrashPingSettings {
  const pairs = { relay: ['BASECAMP_URL', 'BASECAMP_APP_ID'], trio: ['NTFY_BASE_URL', 'NTFY_TOPIC'] } as const
  const has   = (keys: readonly string[]) => keys.every(k => env[k])
  if (!has(pairs.relay) && !has(pairs.trio))
    return { on: false, missing: [...pairs.relay, ...pairs.trio].filter(k => !env[k]) }

  const base = env.BASECAMP_URL?.replace(/\/+$/, '')
  return {
    on: true,
    relay: has(pairs.relay) ? { base: base!, endpoint: `${base}/hooks/crash/${encodeURIComponent(env.BASECAMP_APP_ID!)}` } : undefined,
    trio:  has(pairs.trio)  ? { url: env.NTFY_BASE_URL!, token: env.NTFY_TOKEN || undefined, topic: env.NTFY_TOPIC! } : undefined,
  }
}

/** The main database's directory, else the working directory (`:memory:`, no client). */
export function crashRecordPath(db: unknown, cwd = process.cwd()): string {
  const path = (db as { $databases?: Record<string, { path?: string }> } | undefined)?.$databases?.main?.path
  const dir  = path && path !== ':memory:' && !path.startsWith('file::memory:') ? dirname(path) : cwd
  return join(dir, CRASH_RECORD_FILE)
}

function readRecord(file: string): CrashRecord {
  try {
    const r = JSON.parse(readFileSync(file, 'utf8')) as Partial<CrashRecord>
    return { pingedAt: Number(r.pingedAt) || 0, since: Number(r.since) || 0 }
  } catch {
    return { pingedAt: 0, since: 0 }
  }
}

// The logger may be silent and the process is about to exit 1, so the line
// that says a ping did not leave goes to stderr directly (`FJS-747`).
const say = (line: string) => { process.stderr.write(`[notifications] ${line}\n`) }

function writeRecord(file: string, record: CrashRecord) {
  try { writeFileSync(file, JSON.stringify(record)) }
  catch (err) { say(`crash ping: could not write ${file}: ${(err as Error).message}`) }
}

const asError = (err: unknown) => err instanceof Error ? err : new Error(String(err))

function crashMessage(name: string, err: unknown, earlier: CrashRecord): PushMessage {
  const e     = asError(err)
  const stack = (e.stack ?? '').split('\n').slice(1, 6).map(l => l.trim()).join('\n')
  const lines = [e.message || e.name]
  if (stack) lines.push(stack)
  if (earlier.since > 0) {
    const when = earlier.pingedAt ? ` since ${new Date(earlier.pingedAt).toISOString()}` : ''
    lines.push(`Crashed ${earlier.since} more time${earlier.since === 1 ? '' : 's'}${when} without a ping.`)
  }
  return { title: `${name} crashed on ${hostname()}`, body: lines.join('\n\n'), priority: 5, tags: ['rotating_light'] }
}

/**
 * POSTs the report to Basecamp's crash route. Null when Basecamp has it, which
 * a 2xx of either kind and a 429 both mean; otherwise the reason it did not,
 * and the caller falls back.
 */
async function relayCrash(relay: CrashRelay, err: unknown, earlier: CrashRecord, deliver: typeof fetch): Promise<string | null> {
  const e = asError(err)
  const report = { message: e.message || e.name, stack: e.stack ?? '', host: hostname(), missed: earlier.since }
  try {
    const res = await deliver(relay.endpoint, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify(report),
      signal:  AbortSignal.timeout(RELAY_TIMEOUT_MS),
    })
    return res.ok || res.status === 429 ? null : `Basecamp at ${relay.base} answered ${res.status}`
  } catch (err) {
    return `Basecamp at ${relay.base} did not answer: ${(err as Error).message}`
  }
}

export interface CrashPingOptions {
  env?:     Record<string, string | undefined>
  /** The test seam, used for the relay and handed to `ntfy()`. */
  deliver?: typeof fetch
  now?:     () => number
}

/**
 * Prints the one boot line that says whether a crash pings, and listens for
 * `app:crash` when it does. A listener that throws would be swallowed by
 * junction's crash path, so every failure here is a stderr line instead.
 */
export function listenForCrash(app: App, db: unknown, opts: CrashPingOptions = {}) {
  const settings = crashPingSettings(opts.env ?? process.env)
  if (!settings.on) {
    app.logger?.info(`🔕 crash ping off`, { missing: settings.missing.join(', ') })
    return
  }
  const { relay, trio } = settings
  // The topic is the address, and on a public server whoever knows it can read
  // the pings, so the boot line names the servers only.
  app.logger?.info(`🔔 crash ping`, { ...(relay && { basecamp: relay.base }), ...(trio && { ntfy: trio.url }) })

  const file    = crashRecordPath(db)
  const now     = opts.now ?? Date.now
  const deliver = opts.deliver ?? fetch
  const driver  = trio && ntfy({ url: trio.url, token: trio.token, deliver: opts.deliver })
  const name    = app.config?.name || 'app'

  app.events?.on('app:crash', async (data) => {
    const at     = now()
    const before = readRecord(file)
    const missed = { pingedAt: before.pingedAt, since: before.since + 1 }
    if (before.pingedAt && at - before.pingedAt < CRASH_WINDOW_MS) return writeRecord(file, missed)

    const error = (data as { error?: unknown } | undefined)?.error
    if (relay) {
      const failed = await relayCrash(relay, error, before, deliver)
      if (!failed) return writeRecord(file, { pingedAt: at, since: 0 })
      if (!driver) {
        say(`crash ping not sent: ${failed}`)
        return writeRecord(file, missed)
      }
      say(`crash ping: ${failed}; sending to ntfy instead`)
    }

    try {
      await driver!.send({ pushTopic: trio!.topic }, crashMessage(name, error, before), app)
      writeRecord(file, { pingedAt: at, since: 0 })
    } catch (err) {
      // Counted, not windowed: a ping that never left must not silence the
      // next ten minutes.
      say(`crash ping not sent: ${(err as Error).message}`)
      writeRecord(file, missed)
    }
  })
}
