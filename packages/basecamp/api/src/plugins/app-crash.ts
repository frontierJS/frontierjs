// src/plugins/app-crash.ts — an app Basecamp deployed reports that it crashed.
//
//   POST /hooks/crash/{appId}   { message, stack?, host?, missed? }
//     → 202 { queued: true } · 202 { queued: false, reason } with crash alerts off
//     · 400 a body that is not a crash · 404 no such App · 429 over the limit
//     · 503 the fan-out could not be queued
//
// The app holds its exit for at most 3 s while it reports (`FJS-D2185`), so
// nothing is delivered here: the fan-out is the `app:crashed` job's. A 404 and
// a 503 are what tell the app to fall back to its own ntfy settings; a 202
// with alerts off is an answer, and the app sends nothing else.
//
// No credential (`FJS-D2358`): the App id is in every link to the app, so
// anyone who has seen one can page its channels. The per-App limit caps that
// at what a crash loop already sends, one report per the app's 10-minute
// window (`FJS-D2186`), with room for a lost window file.

import { CRASH_JOB, type CrashReport } from '../jobs/app-crashed.job.ts'
import type { App } from '@frontierjs/junction'

export const CRASH_PATH = '/hooks/crash/{appId}'

/** Reports one App may send in an hour. */
export const CRASH_LIMIT     = 12
const        CRASH_WINDOW_MS = 60 * 60_000

const LIMITS = { message: 2000, stack: 8000, host: 255 }

/** The body as a crash report, or the sentence that says why it is not one. */
export function parseCrash(body: unknown): CrashReport | string {
  const b = (body ?? {}) as Record<string, unknown>
  if (typeof b.message !== 'string' || !b.message.trim()) return 'a crash report needs `message`, the error\'s message'
  for (const key of ['stack', 'host'] as const)
    if (b[key] != null && typeof b[key] !== 'string') return `\`${key}\` is a string`
  if (b.missed != null && !(Number.isInteger(b.missed) && (b.missed as number) >= 0))
    return '`missed` is a whole number of crashes'
  return {
    message: b.message.slice(0, LIMITS.message),
    stack:   String(b.stack ?? '').slice(0, LIMITS.stack),
    host:    String(b.host ?? '').slice(0, LIMITS.host),
    missed:  (b.missed as number | undefined) ?? 0,
  }
}

/** A count per App id over a fixed window. Only an App that exists is
 *  counted, so the map is bounded by the fleet and not by what a stranger
 *  sends. In-process: a restart forgives, which costs at most one more page. */
export function crashLimiter(max = CRASH_LIMIT, windowMs = CRASH_WINDOW_MS, now = () => Date.now()) {
  const seen = new Map<string, { count: number; resetAt: number }>()
  return (appId: string): number | null => {
    const at = now()
    let bucket = seen.get(appId)
    if (!bucket || bucket.resetAt <= at) seen.set(appId, bucket = { count: 0, resetAt: at + windowMs })
    return ++bucket.count > max ? Math.max(1, Math.ceil((bucket.resetAt - at) / 1000)) : null
  }
}

export function appCrash(app: App) {
  const overLimit = crashLimiter()

  app.post(CRASH_PATH, async (ctx) => {
    const report = parseCrash(ctx.body)
    if (typeof report === 'string') return ctx.json({ message: report }, 400)

    // asSystem(): the caller is an app's container, which holds no principal.
    const row = await (app.db as any).asSystem().app.findFirst({
      where:  { id: ctx.route.appId, deletedAt: null },
      select: { id: true, workspaceId: true, isCrashAlerted: true },
    })
    if (!row) return ctx.json({ message: 'no such app' }, 404)

    const retryAfter = overLimit(row.id)
    if (retryAfter != null) {
      const res = ctx.json({ message: `more than ${CRASH_LIMIT} crash reports this hour; the next is accepted in ${retryAfter}s` }, 429)
      res.headers.set('retry-after', String(retryAfter))
      return res
    }

    if (!row.isCrashAlerted) return ctx.json({ queued: false, reason: 'crash alerts are off for this app' }, 202)

    try {
      await (app as any).jobs.dispatch(CRASH_JOB, { appId: row.id, ...report },
        { actor: null, tenant: row.workspaceId })
    } catch (err) {
      app.logger.error('crash report not queued', { appId: row.id, error: (err as Error).message })
      return ctx.json({ message: 'the crash could not be queued' }, 503)
    }
    app.logger.warn('app crashed', { appId: row.id, host: report.host, missed: report.missed })
    return ctx.json({ queued: true }, 202)
  }, { maxBodySize: 16 * 1024 })
}
