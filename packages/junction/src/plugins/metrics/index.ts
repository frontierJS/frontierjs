// src/plugins/metrics/index.ts — keeping what `/metrics` only ever said once.
//
// `registerMetricsSource` collects; nothing kept. The merged value existed for
// the duration of one HTTP response and was then gone, which is why no
// threshold in any app built on this was evaluable (`FJS-956`). This plugin is
// the puller and the pruner, and it ships here rather than as two `*.job.ts`
// files in each app for the ordinary reason: two copies of one clock drift, and
// the second app to want this would have written them again.
//
// Two timers rather than caravan jobs, following the outbox relay next door.
// The work is idempotent on a key the database holds, so a fire that overlaps a
// restart costs nothing, and neither pass needs the queue's durability — a
// missed scrape is a gap in a graph, which is a thing this store can express.

import type { App } from '../../core/app.ts'
import { collectMetrics } from '../../transport/health.ts'
import { counterIncrease, seriesKey } from '../../core/metrics.ts'

/** What the plugin claims as `app.metrics`. Both passes are exposed because
 *  both are things an operator asks for by hand: a fold before reading a
 *  dashboard, and a reading before a deploy. It is also what makes the shipped
 *  passes drivable by a test rather than reimplemented by one. */
export interface RecordOptions {
  /** What distinguishes this series from others of the same name — a server id,
   *  a queue name. Sorted into the key, so the object's insertion order is not
   *  part of the series' identity. */
  labels?: Record<string, string | number>
  /** `gauge` unless the number only ever climbs. Getting it wrong is not fatal
   *  and is not symmetric: a counter read as a gauge draws an uninformative
   *  graph, a gauge read as a counter invents a reset that never happened. */
  type?:   'counter' | 'gauge'
  unit?:   string
  /** The instant this reading is FOR, not when it was written — a heartbeat
   *  reports what it saw a moment ago. Rounded down to the minute. */
  at?:     number
}

export interface MetricsApi {
  scrapeNow(): Promise<void>
  rollupNow(): Promise<void>
  /** Keep a reading this app measured itself — a machine it manages, a queue it
   *  watches. The scrape covers what the PROCESS knows; this is everything
   *  else, and it is pushed because that is the schedule those things report on. */
  record(name: string, value: number, opts?: RecordOptions): Promise<void>
  stats(): { series: number, written: number, folded: number, pruned: number, refused: number }
}

export interface MetricsPluginOptions {
  /** How often a reading is taken. One minute is the raw resolution the store
   *  is designed around; changing it changes what a rate means. */
  scrapeMs?: number
  /** How often complete hours are folded and redundant raw pruned. */
  rollupMs?: number
  /** How long raw readings are kept. Anything older has an hour row covering
   *  it and is redundant, not lost. */
  rawRetentionMs?: number
  /** Which series only ever go up. DECLARED, never guessed — see below. */
  counters?: RegExp[]
}

const HOUR   = 3_600_000
const hourOf = (ms: number) => Math.floor(ms / HOUR) * HOUR
/** Rounded to the minute, so a scrape a second late writes the same key as one
 *  on time — which is what makes the composite key an idempotency guarantee
 *  rather than a coincidence. */
const minuteOf = (ms: number) => Math.floor(ms / 60_000) * 60_000
/** Floats do not sum associatively, so the fold check is a tolerance and not
 *  `===`. Wide enough for drift, far too narrow to hide a lost point. */
const EPSILON = 1e-6

/**
 * The default counter set.
 *
 * An unlisted series is a `gauge`, which is the answer that is never WRONG,
 * only less useful: treating a counter as a gauge gives an uninformative graph,
 * while treating a gauge as a counter invents a reset that never happened.
 */
const DEFAULT_COUNTERS = [/^http\.requests\./, /^http\.responses\./, /^cache\.(hits|misses|sets|evicts)$/]

/** Flatten the collector's nested object into dotted names. Only numbers become
 *  series — a version string is not a measurement, and a store that accepted
 *  one would hold text nobody can threshold. */
function flatten(node: unknown, prefix = '', out: Array<[string, number]> = []): Array<[string, number]> {
  if (typeof node === 'number' && Number.isFinite(node)) { out.push([prefix, node]); return out }
  if (node && typeof node === 'object' && !Array.isArray(node))
    for (const [k, v] of Object.entries(node as Record<string, unknown>))
      flatten(v, prefix ? `${prefix}.${k}` : k, out)
  return out
}

export function metricsPlugin(opts: MetricsPluginOptions = {}) {
  const scrapeMs   = opts.scrapeMs       ?? 60_000
  const rollupMs   = opts.rollupMs       ?? HOUR
  const retentionMs= opts.rawRetentionMs ?? 48 * HOUR
  const counters   = opts.counters       ?? DEFAULT_COUNTERS

  let scrapeTimer: ReturnType<typeof setInterval> | null = null
  let rollupTimer: ReturnType<typeof setInterval> | null = null
  let scraping = false, folding = false
  let startedAt = Date.now()

  // What this plugin itself reports, so the store answers a question about
  // itself through the same seam it is fed by — a cardinality explosion is
  // otherwise invisible until a disk fills.
  let series = 0, written = 0, folded = 0, pruned = 0, refused = 0

  return {
    name: 'metrics-store',

    register(app: App): void {
      startedAt = Date.now()
      const api: MetricsApi = {
        scrapeNow: () => scrape(app),
        rollupNow: () => rollup(app),
        record:    (name: string, value: number, opts?: RecordOptions) =>
                     record(app, name, value, opts ?? {}),
        stats:     () => ({ series, written, folded, pruned, refused }),
      }
      // claim() refuses to overwrite, which is what stops two of these over one
      // table from each driving the other's clock (Invariant 5).
      if (typeof (app as { claim?: unknown }).claim === 'function')
        (app as unknown as { claim(n: string, v: unknown): void }).claim('metrics', api)
      else (app as { metrics?: MetricsApi }).metrics = api

      app.registerMetricsSource?.('metricsStore', () => api.stats())
    },

    async boot(app: App): Promise<void> {
      // One reading before the first tick, so a short-lived process still
      // leaves a row rather than nothing.
      await scrape(app)
      scrapeTimer = setInterval(() => { void scrape(app) }, scrapeMs)
      rollupTimer = setInterval(() => { void rollup(app) }, rollupMs)
      // Neither is a reason for the process to stay alive.
      if (scrapeTimer.unref) scrapeTimer.unref()
      if (rollupTimer.unref) rollupTimer.unref()
    },

    async shutdown(): Promise<void> {
      if (scrapeTimer) { clearInterval(scrapeTimer); scrapeTimer = null }
      if (rollupTimer) { clearInterval(rollupTimer); rollupTimer = null }
    },
  }

  /**
   * The one place a reading becomes rows.
   *
   * Both writers go through it — the scrape and `record()` — because a series
   * is addressed by `labelsKey`, which is `@unique`: two callers spelling one
   * series differently mint TWO series and each then sees half the readings,
   * which draws a graph with a step in it and says nothing.
   *
   * `at` is a MINUTE, so a second write inside one minute updates the point
   * rather than adding one. That is what makes a re-scrape a no-op and what
   * lets a caller record on whatever schedule it already has — a heartbeat
   * every thirty seconds keeps the later reading rather than doubling the row
   * count.
   */
  async function writePoint(
    db:     any,
    name:   string,
    value:  number,
    at:     number,
    type:   'counter' | 'gauge',
    labels?: Record<string, string | number> | null,
    unit?:   string,
  ): Promise<void> {
    const key = seriesKey(name, labels)
    const now = new Date().toISOString()
    const s = await db.metricSeries.upsert({
      where:  { labelsKey: key },
      create: { name, labelsKey: key, labels: labels ?? {}, type, unit: unit ?? null, lastSeenAt: now },
      update: { lastSeenAt: now },
    })
    await db.metricPoint.upsert({
      where: { seriesId: s.id, at }, create: { seriesId: s.id, at, value }, update: { value },
    })
    written++
  }

  /**
   * Record one reading an app measured itself.
   *
   * The scrape reads `/metrics`, which is everything the PROCESS knows about
   * itself. Anything else an app measures — a machine it manages, a queue it
   * watches, a third party it polls — arrives on whatever schedule that thing
   * reports on, so it is pushed rather than pulled.
   *
   * It goes through the plugin rather than an app writing the tables directly,
   * which is the whole reason the method exists: `labelsKey` is the series'
   * identity and inventing it at a call site is inventing a second series.
   */
  async function record(
    app:  App,
    name: string,
    value: number,
    opts: { labels?: Record<string, string | number>, type?: 'counter' | 'gauge', unit?: string, at?: number } = {},
  ): Promise<void> {
    const db = sys(app); if (!db) return
    if (!Number.isFinite(value)) return
    await writePoint(db, name, value, minuteOf(opts.at ?? Date.now()),
                     opts.type ?? 'gauge', opts.labels ?? null, opts.unit)
  }

  /** Overlap is refused rather than queued, for the outbox relay's reason: a
   *  pass slower than its interval otherwise stacks passes that fight. */
  async function scrape(app: App): Promise<void> {
    if (scraping) return
    scraping = true
    try {
      const db = sys(app); if (!db) return
      const at   = minuteOf(Date.now())
      const flat = flatten(collectMetrics(app, startedAt))

      // The scraper's own liveness, written as a series like any other.
      // Without it a scrape that STOPPED and a value that is not CHANGING draw
      // the same flat line, and nothing in the data separates them.
      flat.push(['up', 1])

      for (const [name, value] of flat)
        await writePoint(db, name, value, at, counters.some(re => re.test(name)) ? 'counter' : 'gauge')
      series = await db.metricSeries.count({})
    } catch (err) {
      app.logger?.error?.('[Junction] metrics scrape failed', { error: (err as Error)?.message })
    } finally { scraping = false }
  }

  /**
   * Fold complete hours, then prune the raw that is now redundant — IN THAT
   * ORDER, and only for hours whose fold has been read back.
   *
   * The failure this is arranged around is that a rollup which drops points
   * LOOKS LIKE A SMOOTHER GRAPH: nothing errors, nothing empties, and the
   * numbers stay plausible. The sum check is the only thing between that and a
   * store that quietly lies.
   */
  async function rollup(app: App): Promise<void> {
    if (folding) return
    folding = true
    try {
      const db = sys(app); if (!db) return
      // The newest hour that is definitely COMPLETE. Folding the current hour
      // would write a row later points still belong in, and the prune would
      // then throw them away.
      const cutoff = hourOf(Date.now()) - HOUR

      for (const s of await db.metricSeries.findMany({})) {
        const raw = await db.metricPoint.findMany({
          where: { seriesId: s.id, at: { lte: cutoff + HOUR - 1 } }, orderBy: { at: 'asc' },
        })
        if (!raw.length) continue

        const buckets = new Map<number, Array<{ at: number, value: number }>>()
        for (const p of raw) {
          const h = hourOf(p.at); const b = buckets.get(h)
          b ? b.push(p) : buckets.set(h, [p])
        }

        for (const [hour, readings] of buckets) {
          const values = readings.map(r => r.value)
          const sum    = values.reduce((a, b) => a + b, 0)
          // THE ONE FIGURE THAT CANNOT BE COMPUTED LATER — a reset is visible
          // only as a drop between adjacent raw points, and this is the last
          // moment those exist.
          const increase = s.type === 'counter' ? counterIncrease(readings) : null
          const figures  = { min: Math.min(...values), max: Math.max(...values), sum, count: values.length, increase }

          await db.metricHour.upsert({
            where: { seriesId: s.id, hour }, create: { seriesId: s.id, hour, ...figures }, update: figures,
          })
          folded++

          const expired = readings.filter(p => p.at < Date.now() - retentionMs)
          if (!expired.length) continue

          // Read the row BACK — not the variable just written — and compare it
          // to the raw it claims to replace. A fold that lost a point fails
          // here and the raw survives, which is the outcome worth having: a
          // store that is too big is a nuisance, one that is wrong is worse
          // than none.
          const rolled = await db.metricHour.findFirst({ where: { seriesId: s.id, hour } })
          if (!rolled || Math.abs(rolled.sum - sum) > EPSILON || rolled.count !== values.length) {
            refused++
            app.logger?.error?.('[Junction] metrics rollup refused to prune', {
              series: s.name, hour: new Date(hour).toISOString(),
              rolled: rolled?.sum, count: rolled?.count, raw: sum, rawCount: values.length,
            })
            continue
          }
          const upTo = Math.max(...expired.map(p => p.at))
          await db.metricPoint.deleteMany({ where: { seriesId: s.id, at: { lte: upTo } } })
          pruned += expired.length
        }
      }
    } catch (err) {
      app.logger?.error?.('[Junction] metrics rollup failed', { error: (err as Error)?.message })
    } finally { folding = false }
  }
}

/** The system client, or null when this app has no litestone db — in which case
 *  there is nothing to write to and saying so once is enough. */
function sys(app: App): any | null {
  const db = (app as any).db
  return db?.asSystem ? db.asSystem() : (db ?? null)
}
