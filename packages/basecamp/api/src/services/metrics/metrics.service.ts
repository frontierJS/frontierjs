// src/services/metrics/metrics.service.ts — reading what the store kept.
//
// Mounted at /metrics-store. Custom methods dispatch on X-Service-Method:
//   read
//
// NOT `/metrics`: that path is `healthPlugin`'s and answers what is true NOW,
// as a scrape target. This service answers what WAS true, out of the rows
// `metricsPlugin` kept. Two questions, two surfaces, and naming them the same
// thing would be the one confusion this whole feature exists to remove.
//
// ─── Why this exists at all ───────────────────────────────────────────────
//
// `MetricSeries`, `MetricPoint` and `MetricHour` arrived from junction and had
// no API surface — three models nothing could read, which is the shape
// `AlertRule` sat in for a month (`FJS-123`). A store nothing reads is also a
// store whose fold cannot be caught lying in production: the drive grades the
// arithmetic, and only a reader grades the data.
//
// ─── Why requireSystemAdmin ───────────────────────────────────────────────
//
// The series here are the CONTROL PLANE's own — `process.memoryMb`,
// `http.requests.total`, `up` — declared `@@tenant(none)` because a reading is
// about this process and belongs to nobody's workspace. So there is no
// workspace to scope to, and the honest gate is the hub's: not a screen a
// member is refused, a surface they have no business knowing exists.
//
// THIS DECISION REOPENS the day a heartbeat writes per-server series
// (`server.cpuPercent{serverId}`), because those ARE a workspace's through the
// server. `labels` is the column that would carry it and the scoping would be a
// row policy over that relation — deliberately not invented here, since a
// policy written against labels nothing writes yet is a guess.

import { createService, $, BadRequest } from '@frontierjs/junction'
import { isStale }                      from '@frontierjs/junction'
import { requireSystemAdmin }           from '../../core/hooks.ts'
import type { BasecampApp }             from '../../basecamp.types.ts'

const HOUR = 3_600_000
/** What `metricsPlugin` keeps at raw resolution. Anything older has an hour row
 *  covering it, so a query reaching past this is answered from the fold. */
const RAW_WINDOW_MS = 48 * HOUR
const MAX_POINTS    = 5_000

export function createMetricsService(app: BasecampApp) {
  // The models are `@@gate("8")` — nothing below asSystem() has anything to say
  // to them, and this service is the only reader. The gate above is what makes
  // that safe; `asSystem()` here is the bypass said out loud rather than
  // assumed, as `hub.service.ts` does it next door.
  const sys = (): any => app.db.asSystem()

  return createService({
    name: 'metrics-store',
    // Every method, including find. There is no public half.
    //
    // UNDER `hooks:`, and this is worth the line: a top-level `before:` is not
    // an error, it is silently ignored, and the service then answers every
    // caller. Written that way first, it took a test asserting the REFUSAL to
    // notice — a gate that is missing looks exactly like a gate that passed.
    hooks: {
      before: { all: [requireSystemAdmin()] },
    },

    // `methods:` is a LIST of names and not the implementations — without it a
    // base service answers every CRUD verb it was never given, which on a
    // service with no model is a 500 rather than a refusal (infra.service.ts
    // and hub.service.ts both say so).
    methods: ['find', 'read'],

    /**
     * The series this app is keeping, and whether anything is still writing
     * them.
     *
     * `stale` is the column that earns its place: a scrape that STOPPED and a
     * value that is not CHANGING draw the same flat line, and no amount of
     * looking at a chart separates them. `up` is written by the scraper itself
     * for the same reason — a series present but stale says the process is
     * alive and the scrape is not.
     */
    async find() {
      const now  = Date.now()
      const rows = await sys().metricSeries.findMany({ orderBy: { name: 'asc' } })
      return rows.map((s: any) => ({
        ...s,
        stale: isStale(s.lastSeenAt, now),
      }))
    },

  /**
     * One series over a window.
     *
     * THE TIER IS THE READER'S CHOICE, NOT THE CALLER'S, and that is the only
     * interesting decision here. Raw exists for 48 hours; hourly rows exist
     * for every hour ever folded, including recent ones, because the fold
     * keeps as well as writes. So a window inside the raw retention is
     * answered at minute resolution and anything reaching past it at hour
     * resolution — a caller asking for a week cannot be given minutes that
     * were pruned, and a caller asking for an hour should not be handed a
     * single averaged row.
     *
     * The answer SAYS which tier served it. A chart that silently changed
     * resolution when its range crossed 48 hours would show a step nobody
     * could account for, and the first explanation anybody reaches for is
     * that the data changed.
     */
    async read() {
      // BOTH, because the two transports carry arguments differently: a GET
      // over HTTP has no body and its parameters are the query string, while a
      // service call — the browser client's, and a test's — passes a payload.
      // A method reading only one of them works over one transport and answers
      // *name is required* over the other.
      const arg  = { ...(($.query as Record<string, unknown>) ?? {}),
                     ...(($.data  as Record<string, unknown>) ?? {}) }
      const name = arg.name as string | undefined
      if (!name) throw new BadRequest('name is required')

      const to   = num(arg.to)   ?? Date.now()
      const from = num(arg.from) ?? to - 6 * HOUR
      if (from >= to) throw new BadRequest('from must be before to')

      const series = await sys().metricSeries.findFirst({ where: { labelsKey: name } })
      if (!series) return { series: null, tier: null, points: [] }

      const raw = from >= Date.now() - RAW_WINDOW_MS

      if (raw) {
        const points = await sys().metricPoint.findMany({
          where: { seriesId: series.id, at: { gte: from, lte: to } },
          orderBy: { at: 'asc' }, limit: MAX_POINTS,
        })
        return { series, tier: 'raw', points }
      }

      const hours = await sys().metricHour.findMany({
        where: { seriesId: series.id, hour: { gte: from, lte: to } },
        orderBy: { hour: 'asc' }, limit: MAX_POINTS,
      })
      // `increase` is null on a gauge and is the whole answer on a counter —
      // handed over as-is rather than folded into `value`, because a caller
      // that averaged a counter's cumulative readings would draw a line that
      // means nothing and looks fine.
      return { series, tier: 'hour', points: hours }
    },
  })
}

/** The wire carries strings. A range that silently became `NaN` would be
 *  answered as "no points", which reads as an empty chart rather than a bad
 *  request — so an unparseable bound is undefined and takes the default. */
function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}
