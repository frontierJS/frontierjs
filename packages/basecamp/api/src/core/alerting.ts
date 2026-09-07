// src/core/alerting.ts — has this rule been breached?
//
// Pure. No database, no clock of its own, no app — the caller hands over the
// points it read and the instant it read them at. That is what makes the
// interesting half of `FJS-123` gradeable without standing up a metric store,
// and the reason this is a module rather than four branches inside the job.
//
// ─── What the answers have to survive ─────────────────────────────────────
//
// An alert that fires wrongly is noise; an alert that does NOT fire is the
// thing this whole chain exists to prevent, and both failures look identical
// from a dashboard. So every not-breached answer carries a REASON, and the two
// that are not "the number is fine" — no data at all, and a window nothing has
// covered yet — are named separately, because an evaluator reporting *no
// breach* for a series nobody is writing is the silence the store was built to
// break.

import type { ComparisonOp } from '../../../db/schema.d.ts'

/** One reading. `at` is epoch ms — `MetricPoint.at`'s own units. */
export interface Reading { at: number; value: number }

export interface Condition {
  operator:   ComparisonOp
  threshold:  number
  /** Zero fires on the newest reading. Above zero, the breach must HOLD. */
  forMinutes: number
}

/** Why a window is or is not breached. `holding` is the only firing answer. */
export type Verdict =
  | { breached: true;  reason: 'holding';    value: number; since: number }
  | { breached: false; reason: 'no-data' }
  | { breached: false; reason: 'uncovered';  value: number; coveredMs: number }
  | { breached: false; reason: 'recovered';  value: number }

/**
 * Does one value cross the line?
 *
 * Four operators and no fifth. The fifth anybody reaches for is *stale*, and
 * staleness is already a series: `metricsPlugin` writes `up` on every pass, so
 * `up < 1` is the staleness rule and needs no operator that ignores its own
 * threshold.
 */
export function breaches(value: number, operator: ComparisonOp, threshold: number): boolean {
  switch (operator) {
    case 'gt':  return value >  threshold
    case 'gte': return value >= threshold
    case 'lt':  return value <  threshold
    case 'lte': return value <= threshold
  }
}

/**
 * Grade a window of readings against a condition.
 *
 * `points` must be ascending by `at`; the caller reads them ordered and this
 * does not re-sort, because a silent sort here would hide a reader that had
 * stopped ordering.
 *
 * Three rules, and the second and third are the ones a first draft gets wrong:
 *
 *   **An empty window is not a breach.** `every` over an empty list is `true`,
 *   so the obvious implementation fires every rule the moment its series stops
 *   being written — the exact opposite of what a missing scrape means.
 *
 *   **The window must be COVERED.** `forMinutes: 5` means the breach has held
 *   for five minutes, not that the five-minute window contains only breaching
 *   points. One reading thirty seconds after a restart satisfies the second
 *   and says nothing about the first, so the span between the oldest and
 *   newest point has to reach the duration before anything fires.
 *
 *   **`forMinutes: 0` reads the newest point and nothing else.** Not the whole
 *   window: a rule with no duration is a rule about right now, and averaging
 *   or requiring the window would make zero mean something other than off.
 */
export function evaluateWindow(points: Reading[], cond: Condition): Verdict {
  if (points.length === 0) return { breached: false, reason: 'no-data' }

  const newest = points[points.length - 1]!

  if (cond.forMinutes <= 0) {
    return breaches(newest.value, cond.operator, cond.threshold)
      ? { breached: true, reason: 'holding', value: newest.value, since: newest.at }
      : { breached: false, reason: 'recovered', value: newest.value }
  }

  // Any point inside the window that is FINE ends the streak, so the earliest
  // breaching point after the last good one is when this started holding.
  let since = -1
  for (let i = points.length - 1; i >= 0; i--) {
    if (!breaches(points[i]!.value, cond.operator, cond.threshold)) break
    since = points[i]!.at
  }
  if (since < 0) return { breached: false, reason: 'recovered', value: newest.value }

  const coveredMs = newest.at - since
  if (coveredMs < cond.forMinutes * 60_000)
    return { breached: false, reason: 'uncovered', value: newest.value, coveredMs }

  return { breached: true, reason: 'holding', value: newest.value, since }
}

/** How a fired rule reads to a person. The value is the reading that fired, not
 *  an average — an operator paged at 3am needs the number they can go and look
 *  at, and a mean of the window is a number no screen anywhere shows. */
export function describeBreach(
  metricName: string,
  cond:       Condition,
  value:      number,
): string {
  const held = cond.forMinutes > 0 ? ` for ${cond.forMinutes}m` : ''
  return `${metricName} is ${round(value)} (${SYMBOL[cond.operator]} ${cond.threshold})${held}`
}

const SYMBOL: Record<ComparisonOp, string> = { gt: '>', gte: '>=', lt: '<', lte: '<=' }

/** Six significant figures is what a memory reading in MB and a ratio both
 *  survive; `toFixed` on either alone reads wrong for the other. */
function round(n: number): number {
  return Number(n.toPrecision(6))
}
