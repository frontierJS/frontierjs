// src/domain/monitor/sweep-heartbeat.ts — has the monitor sweep run lately, and does an outside
// service know.
//
// Basecamp watches everyone else's URL; if its queue stops, nothing watches
// Basecamp, and every monitor reads "up" because nothing is asking
// (`FJS-3896`). Two answers: `/health` fails its `monitor-sweep` check once the
// sweep is overdue, and an optional dead-man URL is hit after every sweep so a
// service OUTSIDE this box (healthchecks.io and the like) alerts when the
// pings stop.

/** The sweep runs every minute and may take up to its 4-minute timeout; past
 *  this with no sweep finished, the queue is not running it. */
export const SWEEP_OVERDUE_MS = 6 * 60_000

/** A ping that outlasts this is abandoned: it must never hold up the next sweep. */
const PING_TIMEOUT_MS = 5_000

let lastSweepAt: number | null = null
const bootedAt = Date.now()

/** Stamp a finished sweep. In process: a restart's first sweep is a minute away, and `isSweepFresh` allows for it. */
export function recordSweep(at = Date.now()): void { lastSweepAt = at }

/** When the last sweep finished as an ISO string, null before the first since boot. */
export function lastSweepIso(): string | null { return lastSweepAt === null ? null : new Date(lastSweepAt).toISOString() }

/**
 * The `/health` check: a sweep has finished inside `SWEEP_OVERDUE_MS`, or the
 * process is younger than that and has had no chance to. A fresh boot reads
 * healthy so a deploy's own health probe is not failed by a sweep that has not
 * come due.
 */
export function isSweepFresh(now = Date.now(), booted = bootedAt, last = lastSweepAt): boolean {
  return now - (last ?? booted) <= SWEEP_OVERDUE_MS
}

/**
 * Hit the dead-man URL. Best-effort: a ping service being down must cost the
 * sweep nothing, so it never throws, and it answers whether the service did.
 */
export async function pingDeadman(url: string | undefined, fetchFn: typeof fetch = fetch): Promise<boolean> {
  if (!url) return false
  try {
    const res = await fetchFn(url, { method: 'GET', signal: AbortSignal.timeout(PING_TIMEOUT_MS), redirect: 'follow' })
    await res.body?.cancel()
    return res.ok
  } catch (err) {
    console.error(`[monitor-sweep] dead-man ping failed: ${(err as Error).message}`)
    return false
  }
}
