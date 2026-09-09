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
 * One reading off a check-in's `health` document, or `null`.
 *
 * `health` is an open Json document written by another process, so every value
 * in it is whatever that process sent. The rule is strict on purpose: `null`
 * and `''` both pass `Number()` as **0**, and a disk reading of 0% is the one
 * wrong answer this number must never give — it reads as an empty disk, which
 * is the opposite of the state an operator needs to see.
 *
 * The writer and every reader ask this, so *what counts as a reading* is one
 * rule rather than one per caller.
 */
export function readingOf(
  health: Record<string, unknown> | null | undefined,
  key:    string,
): number | null {
  const value = health?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

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
    const value = readingOf(health, reading.key)
    if (value === null) continue
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

// ─── the disk picture, kept ──────────────────────────────────────────────
//
// `DiskUsage` is the same shape `Server.health` is and has the same hole in it:
// `@@unique([serverId])`, one row per machine, overwritten by every report. So
// *how full was this box before Tuesday's sweep* was not stale, it was gone —
// which is the question `CleanupRun`'s own schema comment says a disk filling up
// again asks (`FJS-956` named this and deferred it).
//
// **The row stays a snapshot and that is settled.** A second table of
// readings-over-time beside the metric store would be a second owner of the same
// idea; the store is where a series lives.
//
// ─── Two series, and both are SUMS ───────────────────────────────────────
//
// The report carries ten numbers and none of them is *how much disk is docker
// using* — that figure is spread across images, containers and the build cache,
// which is `docker system df`'s own arrangement and not a question anybody asks.
// So what is kept is the two a person actually reads: what is held, and what a
// sweep would free.
//
// A sum cannot be split back apart later, and that is the cost. It is paid
// knowingly: the ten figures are on the row, on the cleanup screen and in the
// estimate beside every button, so the detail is a click away and it is the
// TREND that had nowhere to live. Ten series per machine would also be ten
// `@@unique` identities minted per machine, permanent, to answer a question
// nobody asked.

/** The DiskUsage columns these series are computed from. Narrower than the row
 *  on purpose — a reading that needed a column not named here would be reading
 *  the disk report rather than summarising it. */
export interface DiskFigures {
  imageBytes:                 number
  buildCacheBytes:            number
  imagesReclaimableBytes:     number
  containersReclaimableBytes: number
  buildCacheReclaimableBytes: number
}

export interface DiskReading {
  name:  string
  unit:  string
  label: string
  /** Computed from the row, never read off one column — see above. */
  of:    (figures: DiskFigures) => number
}

export const DISK_READINGS: DiskReading[] = [
  {
    name:  'server.dockerBytes',
    unit:  'bytes',
    label: 'Docker on disk',
    // Containers contribute only a reclaimable figure to `docker system df`, so
    // there is no container size to add here. A machine's writable layers are
    // not measured by this report and this number does not claim to include
    // them.
    of: f => f.imageBytes + f.buildCacheBytes,
  },
  {
    name:  'server.dockerReclaimableBytes',
    unit:  'bytes',
    label: 'Reclaimable',
    // Volumes are NOT in this sum, and the omission is the same one
    // `cleanup.usage` makes for the fleet total: an unused volume's bytes come
    // from `Volume`, which owns per-disk sizes, and adding a figure from a
    // second table would double-count the first time a report was missed.
    of: f => f.imagesReclaimableBytes + f.containersReclaimableBytes + f.buildCacheReclaimableBytes,
  },
]

export const DISK_SERIES = DISK_READINGS.map(r => r.name)

/**
 * Keep the disk picture this report just wrote.
 *
 * Called by `applyDiskReport`, which is the one owner of *the outpost's disk
 * words → what this app stores*; keeping the series anywhere else would put a
 * second reader on the same wire.
 *
 * `at` is the instant the report is FOR. A disk report rides the Outpost's slow
 * clock — five minutes against the heartbeat's thirty seconds — so a queued one
 * describes a machine as it was several minutes ago, and stamping it `now`
 * would draw the wrong hour.
 */
export async function recordDiskUsage(
  app:      BasecampApp,
  serverId: string,
  figures:  DiskFigures,
  at:       string,
): Promise<void> {
  const metrics = (app as { metrics?: { record: Function } }).metrics
  // Same reason `recordHealth` asks: a Basecamp built without the plugin is a
  // legitimate configuration, and a disk report that threw for want of a metric
  // store would take the cleanup screen's figures down with it.
  if (!metrics) return

  const when = Date.parse(at)
  for (const reading of DISK_READINGS) {
    const value = reading.of(figures)
    if (!Number.isFinite(value)) continue
    await metrics.record(reading.name, value, {
      // `gauge`. Bytes on a disk go both ways — that is what a sweep IS — and a
      // counter would report every reclaim as a reset.
      type:   'gauge',
      unit:   reading.unit,
      labels: { serverId },
      at:     Number.isFinite(when) ? when : Date.now(),
    })
  }
}
