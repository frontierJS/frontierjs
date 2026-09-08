// src/core/server-metrics.ts — a machine's readings, kept.
//
// `Server.health` is a snapshot: one Json column, one row per machine,
// overwritten on every check-in. So *what was this box doing on Tuesday* was
// not stale, it was gone — and three widget kinds said so on their own cards
// rather than drawing a line they could not draw (`FJS-956`).
//
// ─── Why this is a module and not four lines in the heartbeat ────────────
//
// Two decisions have to be made in ONE place or the store fills with series
// nobody can read together.
//
//   **Which readings are kept.** An outpost may send anything; `health` is an
//   open Json document. A store that kept every key it was ever handed grows a
//   series per typo, and every one of them is `@@unique` and permanent.
//
//   **What they are CALLED.** `server.cpuPercent{serverId="…"}` is the name a
//   chart, an alert rule and a `metrics-store` read all have to agree on, and
//   the label is what makes the series a workspace's rather than the process's.
//
// The unit is in the name, deliberately: `cpuPercent` cannot be confused with a
// core count the way `cpu` can, and it is the same convention the flattener
// already produces for `process.memoryMb`.

import type { BasecampApp } from '../basecamp.types.ts'

/** One reading: the key the Outpost sends, the series it is kept as, what it is
 *  measured in, and what a person reading a card calls it. Four spellings of one
 *  thing, in one row, because they were in three files and two of them were
 *  wrong for a year (`FJS-1027`). */
export interface ServerReading {
  key:   string
  name:  string
  unit:  string
  label: string
}

/** The keys an outpost reports that this app keeps, in the order a card draws
 *  them. Anything else it sends is its own vocabulary — readable on the
 *  server's own screen out of `Server.health`, and not a series. */
export const SERVER_READINGS: ServerReading[] = [
  { key: 'cpu',    name: 'server.cpuPercent',    unit: 'percent', label: 'CPU'    },
  { key: 'memory', name: 'server.memoryPercent', unit: 'percent', label: 'Memory' },
  { key: 'disk',   name: 'server.diskPercent',   unit: 'percent', label: 'Disk'   },
]

/** What the Outpost sends that is deliberately NOT a series, and why. Declared
 *  rather than implied by absence: *nobody kept this on purpose* and *nobody
 *  noticed this arriving* are the same silence, and the second is the whole of
 *  `FJS-1027`. `servers.crossing` in the suite grades the Outpost's real output
 *  against these two lists together. */
export const SERVER_UNKEPT: Record<string, string> = {
  load: 'not comparable between machines without a core count, so a threshold ' +
        'across a fleet would mean different things on each box',
}

/** The series a chart can ask for, in the order a card draws them. */
export const SERVER_SERIES = SERVER_READINGS.map(r => r.name)

/**
 * Keep whatever of this check-in is a number.
 *
 * A missing key is silence rather than a zero: an outpost that stopped
 * reporting disk and a disk at 0% are different facts, and writing 0 for the
 * first is the store inventing a reading. `isStale` on the series is what
 * answers the first one.
 *
 * `at` is the instant the reading is FOR — the heartbeat's own stamp, not when
 * this ran — because a check-in reports what the machine saw a moment ago and a
 * queued one reports something older still.
 */
export async function recordHealth(
  app:      BasecampApp,
  serverId: string,
  health:   Record<string, unknown> | null | undefined,
  at:       string,
): Promise<void> {
  const metrics = (app as { metrics?: { record: Function } }).metrics
  // A Basecamp built without the plugin is a legitimate configuration, and a
  // heartbeat that threw for want of a metric store would take the fleet's
  // status column down with it.
  if (!metrics || !health) return

  const when = Date.parse(at)
  for (const reading of SERVER_READINGS) {
    const value = Number(health[reading.key])
    if (!Number.isFinite(value)) continue
    await metrics.record(reading.name, value, {
      // `gauge`, and it matters: a percentage read as a counter would have every
      // fall reported as a reset and every hour's `increase` invented.
      type:   'gauge',
      unit:   reading.unit,
      labels: { serverId },
      at:     Number.isFinite(when) ? when : Date.now(),
    })
  }
}
