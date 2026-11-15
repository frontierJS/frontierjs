import { dirname, join } from 'path'
import { hostname } from 'os'
import { readFileSync, writeFileSync } from 'fs'
import { ntfy } from './drivers/ntfy.ts'
import type { App, PushMessage } from './types.ts'

/**
 * The crash ping: one push when the app dies of an uncaught throw (`FJS-D2184`
 * to `FJS-D2187`). junction owns the crash and announces `app:crash`, waiting
 * up to 3 s for its listeners before the drain; this file owns the send.
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

export type CrashPingSettings =
  | { on: true;  url: string; token?: string; topic: string }
  | { on: false; missing: string[] }

/**
 * Both NTFY_BASE_URL and NTFY_TOPIC, or no ping. Basecamp and Workbench set
 * NTFY_BASE_URL for their own pushes and configure this package, so a half-set
 * pair turns the ping off and never refuses boot.
 */
export function crashPingSettings(env: Record<string, string | undefined>): CrashPingSettings {
  const missing = (['NTFY_BASE_URL', 'NTFY_TOPIC'] as const).filter(k => !env[k])
  if (missing.length) return { on: false, missing }
  return { on: true, url: env.NTFY_BASE_URL!, token: env.NTFY_TOKEN || undefined, topic: env.NTFY_TOPIC! }
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

function crashMessage(name: string, err: unknown, earlier: CrashRecord): PushMessage {
  const e     = err instanceof Error ? err : new Error(String(err))
  const stack = (e.stack ?? '').split('\n').slice(1, 6).map(l => l.trim()).join('\n')
  const lines = [e.message || e.name]
  if (stack) lines.push(stack)
  if (earlier.since > 0) {
    const when = earlier.pingedAt ? ` since ${new Date(earlier.pingedAt).toISOString()}` : ''
    lines.push(`Crashed ${earlier.since} more time${earlier.since === 1 ? '' : 's'}${when} without a ping.`)
  }
  return { title: `${name} crashed on ${hostname()}`, body: lines.join('\n\n'), priority: 5, tags: ['rotating_light'] }
}

export interface CrashPingOptions {
  env?:     Record<string, string | undefined>
  /** The test seam, handed to `ntfy()`. */
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
  // The topic is the address, and on a public server whoever knows it can read
  // the pings, so the boot line names the server only.
  app.logger?.info(`🔔 crash ping`, { server: settings.url })

  const file   = crashRecordPath(db)
  const now    = opts.now ?? Date.now
  const driver = ntfy({ url: settings.url, token: settings.token, deliver: opts.deliver })
  const name   = app.config?.name || 'app'

  app.events?.on('app:crash', async (data) => {
    const at     = now()
    const before = readRecord(file)
    const missed = { pingedAt: before.pingedAt, since: before.since + 1 }
    if (before.pingedAt && at - before.pingedAt < CRASH_WINDOW_MS) return writeRecord(file, missed)

    try {
      const error = (data as { error?: unknown } | undefined)?.error
      await driver.send({ pushTopic: settings.topic }, crashMessage(name, error, before), app)
      writeRecord(file, { pingedAt: at, since: 0 })
    } catch (err) {
      // Counted, not windowed: a ping that never left must not silence the
      // next ten minutes.
      say(`crash ping not sent: ${(err as Error).message}`)
      writeRecord(file, missed)
    }
  })
}
