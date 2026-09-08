/*
 * vitals.js — what this machine feels like, read from the OS.
 *
 * Read from `/proc` and `statfs` rather than from Docker: a machine can be
 * fine by Docker's account and out of memory, and the fleet screen's question
 * is about the box.
 *
 * ─── Why this is a module and not four lines in the reporter ─────────────
 *
 * **CPU is a rate and `/proc/stat` is a counter.** The file holds cumulative
 * jiffies since boot, so a single read says what the machine has done since it
 * came up — a number that barely moves and is never the answer anyone wants.
 * The percentage is the delta between two reads, which means this has to
 * REMEMBER, and a reader that remembers is a thing with a lifetime rather than
 * a helper.
 *
 * **And it has to be injectable.** The Outpost's whole test story is that no
 * daemon and no network are needed (`{ run }` for Docker, `{ fetch }` for the
 * reporter); a vitals reader that opened `/proc` directly could only ever be
 * asserted against whatever the test machine happened to be doing.
 *
 * The keys are the OUTPOST's vocabulary. Basecamp keeps three of them as
 * series (`core/server-metrics.ts`); the rest land in `Server.health` and are
 * read on the server's own screen. `load` is deliberately in the second group:
 * it is not comparable between machines without a core count, so it is a number
 * to look at and not one to draw a threshold across.
 */

import { statfs as nodeStatfs } from 'node:fs/promises'

/** The mount the percentage is about. `/` rather than Docker's root dir, which
 *  costs a `docker info` on every heartbeat; a separate `/var/lib/docker` is
 *  reported by `cleanup.report` on the slow clock instead. */
const DISK_PATH = '/'

/** Long enough for the jiffy counters to move on an idle machine, short enough
 *  that it is paid once at startup and never again. */
const FIRST_SAMPLE_MS = 100

export function createVitals({
  readText = (path) => Bun.file(path).text(),
  statfs   = nodeStatfs,
  sampleMs = FIRST_SAMPLE_MS,
} = {}) {
  let previous = null

  /** `/proc/stat`'s first line, summed. `idle` is idle + iowait: a disk-bound
   *  process is not using the CPU, and counting iowait as busy reports a
   *  saturated box every time something copies a file. */
  async function cpuSample() {
    const line   = (await readText('/proc/stat')).split('\n')[0]
    const fields = line.trim().split(/\s+/).slice(1).map(Number)
    if (fields.length < 5 || fields.some(n => !Number.isFinite(n))) return null
    const total = fields.reduce((a, b) => a + b, 0)
    return { total, idle: fields[3] + fields[4] }
  }

  /** A percentage over the window since the last call. The first call has no
   *  window, so it makes one — the alternative is a heartbeat that reports no
   *  CPU until the second tick, which is thirty seconds of a card drawing two
   *  bars instead of three on every machine that just came up. */
  async function cpuPercent() {
    let start = previous
    if (!start) {
      start = await cpuSample()
      if (!start) return null
      await new Promise(r => setTimeout(r, sampleMs))
    }
    const end = await cpuSample()
    if (!end) return null
    previous = end

    const total = end.total - start.total
    const idle  = end.idle  - start.idle
    // A counter that went backwards is a reboot between two reads, and a window
    // of zero is two reads inside one jiffy. Neither is a reading.
    if (!(total > 0) || idle < 0) return null
    return round(((total - idle) / total) * 100)
  }

  async function memoryPercent() {
    const text  = await readText('/proc/meminfo')
    const kb    = name => Number(/(\d+)/.exec(text.split('\n').find(l => l.startsWith(name)) ?? '')?.[1] ?? 0)
    const total = kb('MemTotal'), available = kb('MemAvailable')
    if (!total) return null
    // MemAvailable, not MemFree: page cache is memory the kernel will hand back
    // on demand, and counting it as used reports every warm machine at 99%.
    return round(((total - available) / total) * 100)
  }

  /** `df`'s own arithmetic, which is not `1 - bfree/blocks`: the blocks
   *  reserved for root are neither free to a process nor available to one, so
   *  the denominator is used + available. A percentage that disagreed with
   *  what `df` prints on the box is a number nobody can act on. */
  async function diskPercent() {
    const s = await statfs(DISK_PATH)
    const used  = s.blocks - s.bfree
    const total = used + s.bavail
    if (!(total > 0)) return null
    return round((used / total) * 100)
  }

  async function loadAverage() {
    const first = Number((await readText('/proc/loadavg')).split(' ')[0])
    return Number.isFinite(first) ? first : null
  }

  return {
    /**
     * One reading of each. Every value is asked for independently and a failure
     * is an ABSENT key rather than a zero — a machine whose `/proc` this build
     * cannot read and a machine at 0% are different facts, and writing the
     * second for the first is a fleet screen that looks healthy (`FJS-956`
     * draws the same line one layer up: a missing reading is silence).
     */
    async read() {
      const health = {}
      const ask = async (key, fn) => {
        try {
          const value = await fn()
          if (value !== null && Number.isFinite(value)) health[key] = value
        } catch {
          // The key stays absent.
        }
      }
      await ask('cpu',    cpuPercent)
      await ask('memory', memoryPercent)
      await ask('disk',   diskPercent)
      await ask('load',   loadAverage)
      return health
    },
  }
}

/** Two decimals. A percentage carried to fifteen of them is a series whose
 *  every point is a distinct string in the store and a card that jitters. */
function round(n) {
  return Math.round(n * 100) / 100
}
