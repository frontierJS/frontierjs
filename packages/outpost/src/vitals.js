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
 * series (`domain/host/server-metrics.ts`); the rest land in `Server.health` and are
 * read on the server's own screen. `load` is deliberately in the second group:
 * it is not comparable between machines without a core count, so it is a number
 * to look at and not one to draw a threshold across. `memory_breakdown` is a
 * table, not a series (`FJS-D1824`). A caller that sits in a private cgroup
 * namespace (Basecamp in its container) reads the totals with `breakdown: false`
 * and takes the table from the host's heartbeat.
 */

import { statfs as nodeStatfs, readdir as nodeReaddir } from 'node:fs/promises'

/** The mount the percentage is about. `/` rather than Docker's root dir, which
 *  costs a `docker info` on every heartbeat; a separate `/var/lib/docker` is
 *  reported by `cleanup.report` on the slow clock instead. */
const DISK_PATH = '/'

/** Where systemd keeps a unit's cgroup. Every unit's `memory.stat` is read here
 *  and nowhere else; a box on cgroup v1 has no such file, and the breakdown is
 *  then absent rather than a table of zeros. */
const CGROUP_ROOT = '/sys/fs/cgroup'

/** The slices whose children are units, and the single cgroups read whole. */
const UNIT_PARENTS = ['system.slice']
const UNIT_WHOLES  = ['user.slice', 'init.scope']

/** The Outpost's own units and the container runtime's. Everything else on the
 *  box that is not a container scope is the OS (`FJS-D1824`). */
const OUTPOST_UNITS = new Set(['outpost.service', 'basecamp-litestream.service'])
const RUNTIME_UNIT  = /^(docker|containerd|caddy[\w.-]*)\.service$/
const CONTAINER_SCOPE = /^docker-([0-9a-f]{12,64})\.scope$/

/** Long enough for the jiffy counters to move on an idle machine, short enough
 *  that it is paid once at startup and never again. */
const FIRST_SAMPLE_MS = 100

/**
 * The three fields of a `statfs` answer this reads. Stated rather than inferred
 * from the default: node's own type is overloaded across `bigint`, so a caller
 * injecting a plain object is refused by a signature it satisfies completely.
 *
 * @typedef {{ blocks: number, bfree: number, bavail: number }} Blocks
 *
 * @param {object}                                [deps]
 * @param {(path: string) => Promise<string>}     [deps.readText]
 * @param {(path: string) => Promise<Blocks>}     [deps.statfs]
 * @param {(path: string) => Promise<string[]>}   [deps.readDir]   a directory's entry names
 * @param {() => Promise<Map<string, string>|null>} [deps.apps]     full container id -> App id
 * @param {boolean}                               [deps.breakdown]  false for a reader that cannot see the cgroup tree
 * @param {number}                                [deps.sampleMs]
 */
export function createVitals({
  readText = (path) => Bun.file(path).text(),
  statfs   = nodeStatfs,
  readDir  = (path) => nodeReaddir(path),
  apps     = null,
  breakdown = true,
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

  /** `anon` out of one cgroup's `memory.stat`: private memory, which is what
   *  the unit alone would give back by exiting. Not RSS, which counts bun's
   *  mapped binary once per process and read Outpost at 58 MB for 10 of its own
   *  (`FJS-D1824`). A unit that cannot be read is skipped, never zero. */
  async function anonBytes(dir) {
    try {
      const match = /^anon (\d+)$/m.exec(await readText(`${dir}/memory.stat`))
      return match ? Number(match[1]) : null
    } catch {
      return null
    }
  }

  /** Where the machine's memory went, one row per systemd unit and a `kernel`
   *  row for what no unit holds. `kernel` is the headline's own number — used
   *  is MemTotal - MemAvailable — less the units' sum, so the table adds up to
   *  the bar above it. Null when the cgroup tree cannot be read at all: a table
   *  of whatever happened to open would add up to a kernel figure that is
   *  wrong by the units it missed. */
  async function memoryBreakdown() {
    const text = await readText('/proc/meminfo')
    const kb   = name => Number(/(\d+)/.exec(text.split('\n').find(l => l.startsWith(name)) ?? '')?.[1] ?? 0)
    const total = kb('MemTotal') * 1024, used = total - kb('MemAvailable') * 1024
    if (!(total > 0)) return null

    const names = []
    for (const parent of UNIT_PARENTS)
      for (const name of await readDir(`${CGROUP_ROOT}/${parent}`))
        if (/\.(service|scope|mount|slice)$/.test(name)) names.push([`${CGROUP_ROOT}/${parent}/${name}`, name])
    for (const name of UNIT_WHOLES) names.push([`${CGROUP_ROOT}/${name}`, name])

    let byContainer = null
    if (apps) { try { byContainer = await apps() } catch { /* the rows stay unnamed */ } }

    const read = await Promise.all(names.map(async ([dir, unit]) => [unit, await anonBytes(dir)]))
    const rows = []
    for (const [unit, bytes] of read) {
      if (bytes === null) continue
      const container = CONTAINER_SCOPE.exec(unit)?.[1]
      if (container) {
        const full = [...(byContainer?.keys() ?? [])].find(id => id.startsWith(container))
        rows.push({ group: 'apps', unit, bytes, ...(full ? { app_id: byContainer.get(full) } : {}) })
      } else {
        rows.push({ group: OUTPOST_UNITS.has(unit) ? 'outpost' : RUNTIME_UNIT.test(unit) ? 'runtime' : 'os', unit, bytes })
      }
    }
    // Not one unit answered: a cgroup v1 box, or a tree this build cannot see.
    if (!rows.length) return null

    // Never negative: the table is read a few milliseconds after /proc/meminfo,
    // and a process that grew in between must not draw a kernel of minus a MB.
    const kernel = Math.max(0, used - rows.reduce((sum, r) => sum + r.bytes, 0))
    rows.sort((a, b) => b.bytes - a.bytes)
    return { total_bytes: total, used_bytes: used, rows: [...rows, { group: 'kernel', unit: null, bytes: kernel }] }
  }

  return {
    /** The kernel's id for this boot, which changes exactly when the machine
     *  restarts. `null` when unreadable: a box that cannot say is not a box
     *  that did not reboot, and the caller must not treat the two alike. */
    async bootId() {
      try { return (await readText('/proc/sys/kernel/random/boot_id')).trim() || null } catch { return null }
    },

    /**
     * One reading of each. Every value is asked for independently and a failure
     * is an ABSENT key rather than a zero — a machine whose `/proc` this build
     * cannot read and a machine at 0% are different facts, and writing the
     * second for the first is a fleet screen that looks healthy (`FJS-956`
     * draws the same line one layer up: a missing reading is silence).
     */
    async read() {
      /** @type {Record<string, any>} */
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
      try {
        const table = breakdown ? await memoryBreakdown() : null
        if (table) health.memory_breakdown = table
      } catch {
        // The key stays absent.
      }
      return health
    },
  }
}

/** Two decimals. A percentage carried to fifteen of them is a series whose
 *  every point is a distinct string in the store and a card that jitters. */
function round(n) {
  return Math.round(n * 100) / 100
}
