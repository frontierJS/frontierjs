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
// `domain/monitor/probe.ts`, which may not be re-derived here.

import tls                from 'node:tls'
import { defineJob }      from '@frontierjs/caravan'
import { gradePublicUrl, pinTo, type PublicUrlOptions } from '@frontierjs/junction/public-url'
import { runsAsApp }      from '../domain/job/job-context.ts'
import { otherRunIsLive } from '../domain/job/singleton.ts'
import { certWarning, gradeProbe, nextState, type ProbeOutcome } from '../domain/monitor/probe.ts'
import { pingDeadman, recordSweep } from '../domain/monitor/sweep-heartbeat.ts'
import { env }          from '../core/env.ts'
import { notifyPeople, workspaceMembers } from '../domain/notification/notify.ts'
import { deliverOwed, noticeMonitor, redriveOwed } from '../domain/notification/owed.ts'
import type { App }         from '@frontierjs/junction'

/** Probes in flight at once. A sweep of a hundred slow URLs is bounded by the
 *  slowest `timeoutMs`, not by their sum, and not by a hundred sockets. */
const CONCURRENCY = 16

export interface MonitorSweepOptions {
  /** The instant to pick and schedule at. A parameter for `domain/host/reachability.ts`'s
   *  reason: the clock is what a test cannot otherwise stand still. */
  at?:        number
  /** One monitor rather than every due one. */
  monitorId?: string
  /** Where a probe may go. A test with a listener on loopback turns
   *  `allowPrivate` on here; the job passes nothing, and no row or config can,
   *  because whoever writes a monitor is a workspace admin and not an operator
   *  (`FJS-D1018`). */
  destinations?: PublicUrlOptions
  /** Does Basecamp's own network work. Asked once per sweep, and only when a
   *  request failed without an answer; no canary means every failure stands. */
  canary?: () => Promise<boolean>
  /** The expiry of the certificate a host presents, in ms, or null when it
   *  could not be read. Absent means certificates are not read. */
  readCert?: CertReader
}

export interface MonitorSweepResult {
  probed: number
  down:   number
  up:     number
  /** Results thrown away because the canary failed: Basecamp's own DNS or egress, not the sites. */
  suppressed: number
}

/** `address` is the graded IP the connect goes to; `host` is the name for SNI. */
export type CertReader = (host: string, port: number, address: string | null) => Promise<number | null>

/** What every monitor of one sweep shares. */
interface SweepContext {
  at:           number
  result:       MonitorSweepResult
  destinations: PublicUrlOptions
  /** Memoized: one canary per sweep however many monitors failed. */
  egressOk:     () => Promise<boolean>
  readCert?:    CertReader
}

// ─── The canary ──────────────────────────────────────────────────────────

/** Two unrelated hosts: any answer from either proves DNS and egress work here. */
const CANARY_URLS = ['https://www.cloudflare.com/cdn-cgi/trace', 'https://www.google.com/generate_204']
const CANARY_TIMEOUT_MS = 5_000

/**
 * Basecamp's own DNS or outbound network failing makes every probe fail the
 * same way, which reads as every site down and pages for all of them
 * (`FJS-3873`). A status code from either host, whatever it is, proves the
 * request path works; only a failure to get one means it does not.
 */
export async function egressCanary(): Promise<boolean> {
  const tries = CANARY_URLS.map(async (url) => {
    try {
      const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(CANARY_TIMEOUT_MS), redirect: 'manual' })
      await res.body?.cancel()
      return true
    } catch { return false }
  })
  return (await Promise.all(tries)).some(Boolean)
}

/** Certificates are read at most this often per monitor: a handshake per probe is a second connection a minute for nothing. */
const CERT_READ_EVERY_MS = 60 * 60_000
const certReadAt = new Map<string, number>()

/** The expiry of the certificate `host` presents. Verification is off on purpose: an expired or self-signed certificate is the finding, not a reason to read nothing. */
export const readPeerCertExpiry: CertReader = (host, port, address) => new Promise((resolve) => {
  const socket = tls.connect({ host: address ?? host, port, servername: host, rejectUnauthorized: false })
  const done = (v: number | null) => { socket.destroy(); resolve(v) }
  socket.setTimeout(CANARY_TIMEOUT_MS, () => done(null))
  socket.once('error', () => done(null))
  socket.once('secureConnect', () => {
    const t = Date.parse(socket.getPeerCertificate()?.valid_to ?? '')
    done(Number.isFinite(t) ? t : null)
  })
})

/**
 * Probe every monitor that is due, grade it, and tell people about a change.
 *
 * Exported so it can be run at a stated instant; the job below is one caller.
 */
export async function sweepMonitors(
  app:  App,
  opts: MonitorSweepOptions = {},
): Promise<MonitorSweepResult> {
  const db     = (app.db as any).asSystem()
  const at     = opts.at ?? Date.now()
  const result = { probed: 0, down: 0, up: 0, suppressed: 0 }
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

  let canary: Promise<boolean> | null = null
  const ctx: SweepContext = {
    at, result, destinations, readCert: opts.readCert,
    egressOk: () => opts.canary ? (canary ??= opts.canary().catch(() => false)) : Promise.resolve(true),
  }

  let next = 0
  const worker = async () => {
    while (next < due.length) {
      const monitor = due[next++]
      try {
        await checkOne(app, db, monitor, ctx)
      } catch (err) {
        // One monitor's failure to be recorded must not cost the ones after it
        // their check.
        console.error(`[monitor-sweep] ${monitor.name}: ${(err as Error).message}`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, due.length) }, worker))

  if (result.suppressed)
    console.error(`[monitor-sweep] Basecamp's own network failed its canary: ${result.suppressed} failed probe(s) discarded, no monitor moved this sweep`)
  // A notice a crashed pass left owed. After this pass's own moves, which pay
  // theirs inline and are inside the grace `redriveOwed` waits out.
  if (!opts.monitorId) await redriveOwed(app, 'monitor', at)

  return result
}

async function checkOne(
  app:     App,
  db:      any,
  monitor: any,
  { at, result, destinations, egressOk, readCert }: SweepContext,
): Promise<void> {
  const certDue = !!readCert && at - (certReadAt.get(monitor.id) ?? -Infinity) >= CERT_READ_EVERY_MS
  const { outcome, latencyMs, certExpiresAt } = await probe(monitor, destinations, certDue ? readCert : undefined)

  // An answer of any status proves the network; only a request that got none
  // can be Basecamp's own failure. Discarded without a row, a streak or a move,
  // and `nextCheckAt` is untouched so the monitor is due on the next sweep.
  if (outcome.error !== undefined && !await egressOk()) { result.suppressed++; return }

  if (certExpiresAt != null) {
    certReadAt.set(monitor.id, at)
    await guarded(monitor, 'certificate', () => watchCertificate(app, db, monitor, certExpiresAt, at))
  }
  const grade = gradeProbe(monitor, outcome)
  const state = nextState(monitor, grade.ok, at)
  result.probed++

  await db.monitorCheck.create({ data: {
    monitorId:  monitor.id,
    at:         new Date(at).toISOString(),
    isOk:       grade.ok,
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
  // Best-effort: a store failure must not skip the state move below.
  const metrics = (app as { metrics?: { record: Function } }).metrics
  if (metrics && latencyMs !== null)
    await guarded(monitor, 'metric', () => metrics.record('monitor.latencyMs', latencyMs, {
      type: 'gauge', unit: 'ms', labels: { monitorId: monitor.id }, at,
    }))

  // A page for a move is owed by the move: the event row that records it says
  // so in the same transaction, so a crash before the send leaves a row the
  // next sweep re-drives rather than a monitor `down` with nobody told.
  const owes = state.page === 'up' || state.page === 'down'
  let eventId: string | null = null
  if (state.move) {
    const move = state.move
    eventId = await db.$transaction(async (tx: any) => {
      // `transition`, never an update naming the column: it narrows the
      // UPDATE's own WHERE to the from-state, so a monitor an operator paused
      // while the request was in flight stays paused instead of being marked down.
      try { await tx.monitor.transition(monitor.id, move) }
      catch { return null }
      const event = await tx.monitorEvent.create({ data: {
        monitorId:    monitor.id,
        at:           new Date(at).toISOString(),
        fromStatus:   monitor.status,
        toStatus:     state.status,
        message:      grade.message,
        noticeOwedAt: owes ? new Date(at).toISOString() : null,
      } })
      return event.id as string
    })
    if (!eventId) return
  }

  if (!state.page) return
  if (state.page === 'up') result.up++
  else if (state.page === 'down') result.down++

  // A resend moves nothing and owes nothing: a lost one is covered by the next.
  if (state.page === 'resend') {
    await guarded(monitor, 'resend', () => noticeMonitor(app, db, monitor,
      { down: true, message: grade.message, resend: true }))
    return
  }
  const owed = eventId
  if (owed) await guarded(monitor, 'notify', () => deliverOwed(app, 'monitor', owed))
}

/** Warn once per threshold as the certificate nears expiry, and remember what was said. */
async function watchCertificate(app: App, db: any, monitor: any, expiresAt: number, at: number): Promise<void> {
  const prior = {
    expiresAt:  monitor.certExpiresAt ? Date.parse(monitor.certExpiresAt) : null,
    warnedDays: monitor.certWarnedDays ?? null,
  }
  const w = certWarning(expiresAt, prior, at)
  if (w.warn !== null)
    await notifyPeople(app, 'MonitorCertExpiring', await workspaceMembers(app, monitor.workspaceId), {
      monitorId: monitor.id, monitorName: monitor.name, daysLeft: w.daysLeft, expiresAt: new Date(expiresAt).toISOString(),
    }, monitor.workspaceId)
  if (w.warnedDays !== prior.warnedDays || prior.expiresAt !== expiresAt)
    await db.monitor.update({ where: { id: monitor.id }, data: {
      certExpiresAt: new Date(expiresAt).toISOString(), certWarnedDays: w.warnedDays,
    } })
}

/** One step of an item that may fail without skipping the steps after it. */
async function guarded(monitor: any, step: string, fn: () => Promise<unknown>): Promise<void> {
  try { await fn() }
  catch (err) { console.error(`[monitor-sweep] ${monitor.name}: ${step}: ${(err as Error).message}`) }
}

// ─── The request ─────────────────────────────────────────────────────────

/** Redirects are followed by hand: `fetch` follows or refuses, `maxRedirects`
 *  is a count, and each hop's own URL is graded before it is requested — a
 *  public page answering 302 to `http://169.254.169.254/` is the same probe. */
async function probe(
  monitor:      any,
  destinations: PublicUrlOptions,
  readCert?:    CertReader,
): Promise<{ outcome: ProbeOutcome; latencyMs: number | null; certExpiresAt?: number | null }> {
  const started = performance.now()
  const elapsed = () => Math.round(performance.now() - started)

  try {
    let url: string = monitor.url
    const signal = AbortSignal.timeout(monitor.timeoutMs)

    for (let hops = 0; ; hops++) {
      // The connect goes to the address that was graded: a name resolved again
      // by `fetch` could answer loopback this time (`FJS-3357`).
      // Raced against the timeout: the lookup takes no signal, and a resolver
      // that never answers would otherwise hold the probe past `timeoutMs`.
      const graded = await Promise.race([gradePublicUrl(url, destinations), abortion(signal)])
      const pin    = graded.address ? pinTo(graded.url, graded.address) : null
      const tls    = { ...pin?.tls, ...(monitor.isTlsIgnored ? { rejectUnauthorized: false } : {}) }
      // `set`, not a spread: a monitor's own `Host` would be appended beside
      // the pin's and the server handed both.
      const headers = new Headers(monitor.headers ?? {})
      if (pin) headers.set('host', pin.headers.host)
      const res = await fetch(pin?.url ?? url, {
        method:   hops === 0 ? monitor.method : 'GET',
        headers,
        body:     hops === 0 && monitor.method !== 'GET' && monitor.method !== 'HEAD' ? monitor.body ?? undefined : undefined,
        redirect: 'manual',
        signal,
        ...(Object.keys(tls).length ? { tls } : {}),
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
      const latencyMs = elapsed()
      const final = new URL(url)
      // After the answer, so the handshake is not in the latency a monitor reports.
      const certExpiresAt = readCert && final.protocol === 'https:'
        ? await readCert(final.hostname, Number(final.port) || 443, graded.address ?? null).catch(() => null)
        : undefined
      return { outcome: { statusCode: res.status }, latencyMs, certExpiresAt }
    }
  } catch (err) {
    const e = err as Error
    const message = e.name === 'TimeoutError' || e.name === 'AbortError'
      ? `Timed out after ${monitor.timeoutMs}ms`
      : e.message
    return { outcome: { error: message }, latencyMs: null }
  }
}

/** Rejects when the probe's signal fires; the other half of a race with a call that takes none. */
function abortion(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => reject(signal.reason ?? new DOMException('aborted', 'AbortError'))
    if (signal.aborted) fail()
    else signal.addEventListener('abort', fail, { once: true })
  })
}

export default defineJob({
  handler: async (ctx) => {
    const { app } = runsAsApp(ctx, 'monitor-sweep')
    // A sweep that outlived its minute is not joined by the next one.
    if (otherRunIsLive(ctx, 'monitor-sweep')) return
    await sweepMonitors(app, { canary: egressCanary, readCert: readPeerCertExpiry })
    // After the sweep and not before: a ping means the sweep ran to its end.
    recordSweep()
    await pingDeadman(env.DEADMAN_URL)
  },
  // Probes are bounded by their own `timeoutMs`; this bounds the sweep around them.
  timeout: 4 * 60_000,
  // One minute is the interval floor: a monitor's `intervalSeconds` is at least 60,
  // so a slower sweep would add its whole period to every detection.
  cron: '* * * * *',
})
