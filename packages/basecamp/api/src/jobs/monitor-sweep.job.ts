// src/jobs/monitor-sweep.job.ts — the thing that asks a URL whether it is up.
//
// Basecamp watched machines and never a URL (`FJS-1557`): an Outpost can check
// in every minute while the app on it serves a 502. This probes from the Basecamp
// API process, which is an outside view — the point, since a probe from inside
// the box is the one `deployment-run` already makes once per deploy.
//
// The shape is `server-reachability`'s: a cron, a sweep that reads the rows it
// grades (so it is correct on its first fire after a restart), a
// `@@transitions` move so a monitor an operator paused mid-probe stays paused,
// an event row, and a notification only after the move landed. The two
// judgments — did this request count, and what does it do to the monitor — are
// `core/probe.ts`, which may not be re-derived here.

import { defineJob }      from '@frontierjs/caravan'
import { assertPublicUrl, type PublicUrlOptions } from '@frontierjs/junction/public-url'
import { runsAsApp }      from './context.ts'
import { gradeProbe, nextState, type ProbeOutcome } from '../core/probe.ts'
import { fanOutToChannels } from '../core/delivery.ts'
import { notifyPeople, workspaceMembers } from '../core/notify.ts'
import type { BasecampApp } from '../basecamp.types.ts'

/** Probes in flight at once. A sweep of a hundred slow URLs is bounded by the
 *  slowest `timeoutMs`, not by their sum, and not by a hundred sockets. */
const CONCURRENCY = 16

export interface MonitorSweepOptions {
  /** The instant to pick and schedule at. A parameter for `core/reachability.ts`'s
   *  reason: the clock is what a test cannot otherwise stand still. */
  at?:        number
  /** One monitor rather than every due one. */
  monitorId?: string
  /** Where a probe may go. A test with a listener on loopback turns
   *  `allowPrivate` on here; the job passes nothing, and no row or config can,
   *  because whoever writes a monitor is a workspace admin and not an operator
   *  (`FJS-D1018`). */
  destinations?: PublicUrlOptions
}

export interface MonitorSweepResult {
  probed: number
  down:   number
  up:     number
}

/**
 * Probe every monitor that is due, grade it, and tell people about a change.
 *
 * Exported so it can be run at a stated instant; the job below is one caller.
 */
export async function sweepMonitors(
  app:  BasecampApp,
  opts: MonitorSweepOptions = {},
): Promise<MonitorSweepResult> {
  const db     = (app.db as any).asSystem()
  const at     = opts.at ?? Date.now()
  const result = { probed: 0, down: 0, up: 0 }
  // Plain http is a site people watch; it is the destination that is graded.
  const destinations = { allowHttp: true, ...opts.destinations }

  // Every workspace in one pass, the way `alert-evaluate` crosses them: the row
  // tenancy scopes to one workspace and a cron has none.
  const due = await db.monitor.findMany({
    where: opts.monitorId
      ? { id: opts.monitorId, status: { not: 'paused' } }
      : {
          status: { not: 'paused' },
          OR:     [{ nextCheckAt: null }, { nextCheckAt: { lte: new Date(at).toISOString() } }],
        },
    limit: 5_000,
  })

  let next = 0
  const worker = async () => {
    while (next < due.length) {
      const monitor = due[next++]
      try {
        await checkOne(app, db, monitor, at, result, destinations)
      } catch (err) {
        // One monitor's failure to be recorded must not cost the ones after it
        // their check.
        console.error(`[monitor-sweep] ${monitor.name}: ${(err as Error).message}`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, due.length) }, worker))

  return result
}

async function checkOne(
  app:     BasecampApp,
  db:      any,
  monitor: any,
  at:      number,
  result:  MonitorSweepResult,
  destinations: PublicUrlOptions,
): Promise<void> {
  const { outcome, latencyMs } = await probe(monitor, destinations)
  const grade = gradeProbe(monitor, outcome)
  const state = nextState(monitor, grade.ok, at)
  result.probed++

  await db.monitorCheck.create({ data: {
    monitorId:  monitor.id,
    at:         new Date(at).toISOString(),
    ok:         grade.ok,
    statusCode: outcome.statusCode ?? null,
    latencyMs,
    message:    grade.message,
  } })

  await db.monitor.update({ where: { id: monitor.id }, data: {
    failStreak:    state.failStreak,
    lastCheckedAt: new Date(at).toISOString(),
    nextCheckAt:   new Date(state.nextCheckAt).toISOString(),
    lastLatencyMs: latencyMs,
  } })

  // Into the metric store so an `AlertRule` on latency works with no new code.
  const metrics = (app as { metrics?: { record: Function } }).metrics
  if (metrics && latencyMs !== null)
    await metrics.record('monitor.latencyMs', latencyMs, {
      type: 'gauge', unit: 'ms', labels: { monitorId: monitor.id }, at,
    })

  if (state.move) {
    // `transition`, never an update naming the column: it narrows the UPDATE's
    // own WHERE to the from-state, so a monitor an operator paused while the
    // request was in flight stays paused instead of being marked down.
    try {
      await db.monitor.transition(monitor.id, state.move)
    } catch {
      return
    }
    await db.monitorEvent.create({ data: {
      monitorId:  monitor.id,
      at:         new Date(at).toISOString(),
      fromStatus: monitor.status,
      toStatus:   state.status,
      message:    grade.message,
    } })
  }

  if (!state.page) return
  if (state.page === 'up') result.up++
  else if (state.page === 'down') result.down++

  const down = state.page !== 'up'
  // After the move, so a send that throws cannot leave the row `up` with
  // somebody already told it is down.
  await notifyPeople(app, down ? 'monitor_down' : 'monitor_up',
    await workspaceMembers(app, monitor.workspaceId), {
      monitorId:   monitor.id,
      monitorName: monitor.name,
      message:     grade.message,
      resend:      state.page === 'resend',
    })

  const links = await db.monitorChannel.findMany({
    where:   { monitorId: monitor.id },
    include: { channel: true },
  })
  await fanOutToChannels(app, () => db, links.map((l: any) => l.channel), {
    title:    `[${down ? 'down' : 'recovered'}] ${monitor.name}`,
    text:     grade.message,
    severity: down ? 'critical' : 'info',
    action:   down ? 'trigger' : 'resolve',
    // One open incident per monitor, which `nextState` guarantees, so the
    // monitor's id is the key that lets a recovery close what the outage opened.
    dedupKey: `basecamp:monitor:${monitor.id}`,
  }, `monitor-sweep ${monitor.name}`)
}

// ─── The request ─────────────────────────────────────────────────────────

/** Redirects are followed by hand: `fetch` follows or refuses, `maxRedirects`
 *  is a count, and each hop's own URL is graded before it is requested — a
 *  public page answering 302 to `http://169.254.169.254/` is the same probe. */
async function probe(
  monitor:      any,
  destinations: PublicUrlOptions,
): Promise<{ outcome: ProbeOutcome; latencyMs: number | null }> {
  const started = performance.now()
  const elapsed = () => Math.round(performance.now() - started)

  try {
    let url: string = monitor.url
    const signal = AbortSignal.timeout(monitor.timeoutMs)

    for (let hops = 0; ; hops++) {
      await assertPublicUrl(url, destinations)
      const res = await fetch(url, {
        method:   hops === 0 ? monitor.method : 'GET',
        headers:  monitor.headers ?? {},
        body:     hops === 0 && monitor.method !== 'GET' && monitor.method !== 'HEAD' ? monitor.body ?? undefined : undefined,
        redirect: 'manual',
        signal,
        ...(monitor.ignoreTls ? { tls: { rejectUnauthorized: false } } : {}),
      } as RequestInit)

      const location = res.headers.get('location')
      if (res.status >= 300 && res.status < 400 && location) {
        if (hops >= monitor.maxRedirects)
          return { outcome: { error: `Maximum redirects (${monitor.maxRedirects}) exceeded` }, latencyMs: elapsed() }
        url = new URL(location, url).toString()
        continue
      }
      // The body is never read: a status and a time are the whole answer, and a
      // monitor pointed at a large download must not buffer it.
      await res.body?.cancel()
      return { outcome: { statusCode: res.status }, latencyMs: elapsed() }
    }
  } catch (err) {
    const e = err as Error
    const message = e.name === 'TimeoutError' || e.name === 'AbortError'
      ? `Timed out after ${monitor.timeoutMs}ms`
      : e.message
    return { outcome: { error: message }, latencyMs: null }
  }
}

export default defineJob(
  'monitor-sweep',
  async (ctx) => {
    const { app } = runsAsApp(ctx, 'monitor-sweep')
    await sweepMonitors(app)
  },
  // One minute is the interval floor: a monitor's `intervalSec` is at least 60,
  // so a slower sweep would add its whole period to every detection.
  { cron: '* * * * *' },
)
