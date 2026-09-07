// src/core/metrics.ts — reading a counter, and knowing when nobody wrote.
//
// Pure functions, no database, and they live beside `db/metrics.lite` because
// every app that imports those models needs these to read them. Two callers
// each, which is the whole reason this is a module rather than two closures: `counterIncrease` runs at FOLD time in
// the rollup and at READ time over the raw window, and a second implementation
// of reset handling would drift the two apart in exactly the way nobody notices
// — both halves would still return a number.

/** A metric point as either tier hands it over. */
export type Reading = { at: number, value: number }

/**
 * How much a COUNTER actually advanced across these readings.
 *
 * A counter only goes up and returns to zero when the process restarts, so a
 * DROP between two adjacent readings is a restart and not a decrease. The
 * arithmetic everybody writes first — `last - first` — reports a negative
 * number across a restart, and the patch everybody reaches for second —
 * `Math.max(0, last - first)` — reports zero, discarding the whole hour.
 *
 * Prometheus's rule is taken here and it is the conservative one: on a drop,
 * the new value is itself the increase. That UNDERCOUNTS by however far the
 * counter had climbed above the last reading before it reset, which is
 * unknowable — nothing observed it. Undercounting a known amount beats
 * inventing an unknown one.
 *
 * Readings must be in time order; the caller has them that way from the index.
 */
export function counterIncrease(readings: Reading[]): number {
  if (readings.length < 2) return 0
  let total = 0
  for (let i = 1; i < readings.length; i++) {
    const prev = readings[i - 1]!.value
    const cur  = readings[i]!.value
    total += cur < prev ? cur : cur - prev
  }
  return total
}

/**
 * The same figure per second, which is what a threshold is usually written
 * against — *more than 5 errors a second* survives a change of scrape interval
 * and *more than 300 errors* does not.
 *
 * Answers null rather than 0 for a window with no elapsed time, because a rate
 * over no time is not zero, it is unanswerable, and a 0 here is a threshold
 * that silently never fires.
 */
export function counterRate(readings: Reading[]): number | null {
  if (readings.length < 2) return null
  const span = readings[readings.length - 1]!.at - readings[0]!.at
  if (span <= 0) return null
  return counterIncrease(readings) / (span / 1000)
}

/**
 * Is this series still being written?
 *
 * The failure the whole store is blindest to: a scrape that STOPPED and a value
 * that is not CHANGING draw the same flat line, and no amount of looking at the
 * graph separates them. `lastSeenAt` is the only column that can, which is why
 * the scraper writes its own `up` series — a graph going flat is ambiguous, a
 * series that stopped being written is not.
 *
 * `tolerance` is generous by default: a scrape is a cron, and a machine under
 * load runs one late without anything being wrong.
 */
export function isStale(lastSeenAt: string | Date, now = Date.now(), toleranceMs = 5 * 60_000): boolean {
  const t = lastSeenAt instanceof Date ? lastSeenAt.getTime() : Date.parse(lastSeenAt)
  return !Number.isFinite(t) || now - t > toleranceMs
}

/**
 * The unique name of one series: a metric name plus its labels.
 *
 * `MetricSeries.labelsKey` is `@unique` and is what every write upserts on, so
 * two callers that spell one series differently mint two series and each sees
 * half the readings — a graph with a step in it and nothing anywhere saying
 * why. So the spelling is decided once, here, and both writers use it: the
 * scrape (no labels) and `app.metrics.record()` (labels).
 *
 * **Labels are sorted by key.** `{server: 'a', region: 'b'}` and
 * `{region: 'b', server: 'a'}` are the same series, and object insertion order
 * is a property of whichever call site built the object.
 *
 * The format is OpenMetrics' own — `name{k="v",k2="v2"}` — which means a key
 * read out of this database is a name a person can paste into any exporter's
 * documentation and recognise.
 *
 * Values are escaped for `\`, `"` and newline, the three characters that would
 * otherwise let one label's VALUE close the brace and forge another label.
 */
export function seriesKey(name: string, labels?: Record<string, string | number> | null): string {
  const keys = Object.keys(labels ?? {}).sort()
  if (!keys.length) return name
  const pairs = keys.map(k => `${k}="${escapeLabel(String(labels![k]))}"`)
  return `${name}{${pairs.join(',')}}`
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}
