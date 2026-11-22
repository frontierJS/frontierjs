// api/src/domain/laptop/vitals.ts
// How this laptop itself is doing: free disk per mounted drive, memory and swap,
// load against the core count, CPU temperature, battery, uptime, and whether the
// OS is waiting on a reboot or has updates queued. Every value is a file read or
// a `statfs`, nothing shells out, so Home can ask once a minute.
//
// A reading this machine cannot give (no battery, no `/proc` on a Mac, no
// thermal zone) is null, never a zero: an absent battery and an empty one are
// different facts. Each reading carries its own `state`, so the page and the
// Home "Needs you" row grade it the same way.
//
// Outpost's `vitals.js` reads the same files for a fleet server, as percentages
// a series can hold. This one answers in bytes because "13 GB left" is what a
// person acts on.

import { readFileSync, readdirSync } from 'node:fs'
import { statfs as nodeStatfs }       from 'node:fs/promises'
import { cpus, freemem, homedir, totalmem, uptime } from 'node:os'

export type State = 'ok' | 'low' | 'critical'

export type DiskReading = {
  mount: string, device: string | null,
  total: number, avail: number, used: number, pct: number,
  /** The mount holding the home directory, which is the one Home's tile shows. */
  home: boolean,
  state: State,
}
export type Vitals = {
  disks: DiskReading[],
  memory: { total: number, available: number, used: number, pct: number, state: State,
            swap: { total: number, used: number } | null } | null,
  load: { one: number, five: number, fifteen: number, cores: number, state: State } | null,
  temp: { celsius: number, sensor: string, state: State } | null,
  battery: { percent: number, status: string, state: State } | null,
  uptime: { seconds: number, since: string },
  /** Debian and Ubuntu leave a file when a package wants a reboot; elsewhere null. */
  reboot: { required: boolean, packages: string[] } | null,
  /** Ubuntu's update-notifier count, null where the file is not kept. */
  updates: number | null,
  readAt: string,
}

type Blocks = { bsize: number, blocks: number, bfree: number, bavail: number }
export type Deps = {
  readText?: (path: string) => string | null,
  listDir?:  (path: string) => string[],
  statfs?:   (path: string) => Promise<Blocks>,
  home?:     string,
}

// Percent used. A drive at 90% on a 500 GB disk is ~45 GB left, which is the
// point to start clearing; 95% is the point a build or a docker pull fails.
const DISK_LOW = 90, DISK_CRITICAL = 95
// Of memory still available (MemAvailable, so page cache counts as free).
const MEM_LOW = 10, MEM_CRITICAL = 5
// Package temperature. Laptop CPUs throttle near 100 °C, and a build touches 90
// for a minute, so heat is never "critical" -- it is shown, not raised.
const TEMP_LOW = 90
const BATTERY_LOW = 20, BATTERY_CRITICAL = 10

/** Devices that are never a drive someone fills: snap's squashfs loops, and the
 *  EFI partition, which the OS manages and nobody can act on. */
const SKIP_DEVICE = /^\/dev\/(loop|zram)/
const SKIP_FSTYPE = new Set(['vfat', 'squashfs'])

const tryRead = (path: string) => { try { return readFileSync(path, 'utf8') } catch { return null } }
const tryList = (path: string) => { try { return readdirSync(path) } catch { return [] } }

export async function vitals(deps: Deps = {}): Promise<Vitals> {
  const readText = deps.readText ?? tryRead
  const listDir  = deps.listDir  ?? tryList
  const statfs   = deps.statfs   ?? (nodeStatfs as unknown as (p: string) => Promise<Blocks>)
  const home     = deps.home     ?? homedir()

  const seconds = uptime()
  return {
    disks:   await disks(readText, statfs, home),
    memory:  memory(readText),
    load:    load(readText),
    temp:    temperature(readText, listDir),
    battery: battery(readText, listDir),
    uptime:  { seconds, since: new Date(Date.now() - seconds * 1000).toISOString() },
    reboot:  reboot(readText),
    updates: updates(readText),
    readAt:  new Date().toISOString(),
  }
}

// ─── disks ────────────────────────────────────────────────────────────────

/** Every real block device mounted, once each (a bind mount repeats its
 *  device), from `/proc/mounts`; where there is none, `/` and home alone. */
async function disks(readText: (p: string) => string | null, statfs: (p: string) => Promise<Blocks>, home: string) {
  const mounts: { mount: string, device: string | null }[] = []
  const table = readText('/proc/mounts')
  if (table) {
    const seen = new Set<string>()
    for (const line of table.split('\n')) {
      const [device, rawMount, fstype] = line.split(' ')
      if (!device?.startsWith('/dev/') || SKIP_DEVICE.test(device) || SKIP_FSTYPE.has(fstype)) continue
      if (seen.has(device)) continue
      seen.add(device)
      // /proc/mounts escapes a space in a path as \040.
      mounts.push({ mount: rawMount.replace(/\\040/g, ' '), device })
    }
  }
  if (!mounts.length) mounts.push({ mount: '/', device: null }, { mount: home, device: null })

  // The home drive is the mount with the longest prefix of the home path.
  const homeMount = mounts.map(m => m.mount)
    .filter(m => m === '/' || home === m || home.startsWith(m + '/'))
    .sort((a, b) => b.length - a.length)[0]

  const out: DiskReading[] = []
  const seenSize = new Set<string>()
  for (const { mount, device } of mounts) {
    let s: Blocks
    try { s = await statfs(mount) } catch { continue }
    // `df`'s arithmetic: root's reserved blocks are neither used nor available.
    const used  = (s.blocks - s.bfree) * s.bsize
    const avail = s.bavail * s.bsize
    const total = used + avail
    if (!(total > 0)) continue
    // The fallback pair is often one filesystem twice.
    const key = `${s.blocks}:${s.bfree}`
    if (!device && seenSize.has(key)) continue
    seenSize.add(key)
    const pct = round((used / total) * 100)
    out.push({
      mount, device, total, avail, used, pct, home: mount === homeMount,
      state: pct >= DISK_CRITICAL ? 'critical' : pct >= DISK_LOW ? 'low' : 'ok',
    })
  }
  return out.sort((a, b) => Number(b.home) - Number(a.home) || a.mount.localeCompare(b.mount))
}

// ─── memory, load, heat ───────────────────────────────────────────────────

function memory(readText: (p: string) => string | null): Vitals['memory'] {
  const text = readText('/proc/meminfo')
  const kb = (name: string) => {
    const m = text && new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(text)
    return m ? Number(m[1]) * 1024 : null
  }
  const total     = kb('MemTotal')     ?? totalmem()
  const available = kb('MemAvailable') ?? freemem()
  if (!(total > 0)) return null
  const swapTotal = kb('SwapTotal'), swapFree = kb('SwapFree')
  const freePct = (available / total) * 100
  return {
    total, available, used: total - available, pct: round(100 - freePct),
    state: freePct < MEM_CRITICAL ? 'critical' : freePct < MEM_LOW ? 'low' : 'ok',
    swap: swapTotal ? { total: swapTotal, used: swapTotal - (swapFree ?? 0) } : null,
  }
}

/** Load is only meaningful against the core count: 12 on a 12-core laptop is
 *  busy, on a 4-core one it is a queue. The five-minute figure grades it, so
 *  one compile does not paint the panel. */
function load(readText: (p: string) => string | null): Vitals['load'] {
  const text = readText('/proc/loadavg')
  const [one, five, fifteen] = (text ?? '').split(' ').slice(0, 3).map(Number)
  if (![one, five, fifteen].every(Number.isFinite)) return null
  const cores = cpus().length || 1
  const per = five / cores
  return { one, five, fifteen, cores, state: per >= 2 ? 'critical' : per >= 1 ? 'low' : 'ok' }
}

/** The CPU package sensor where the kernel names one, else the hottest zone. */
function temperature(readText: (p: string) => string | null, listDir: (p: string) => string[]): Vitals['temp'] {
  const zones = listDir('/sys/class/thermal').filter(z => z.startsWith('thermal_zone'))
  let best: { celsius: number, sensor: string } | null = null
  for (const z of zones) {
    const sensor = readText(`/sys/class/thermal/${z}/type`)?.trim()
    const milli  = Number(readText(`/sys/class/thermal/${z}/temp`))
    if (!sensor || !Number.isFinite(milli) || milli <= 0) continue
    const reading = { celsius: Math.round(milli / 1000), sensor }
    if (sensor === 'x86_pkg_temp') { best = reading; break }
    if (!best || reading.celsius > best.celsius) best = reading
  }
  return best && { ...best, state: best.celsius >= TEMP_LOW ? 'low' : 'ok' }
}

/** The first `BAT*` supply. Only a battery that is draining can be low: one at
 *  10% on the charger is on its way up. */
function battery(readText: (p: string) => string | null, listDir: (p: string) => string[]): Vitals['battery'] {
  const bat = listDir('/sys/class/power_supply').find(n => /^BAT/.test(n))
  if (!bat) return null
  const percent = Number(readText(`/sys/class/power_supply/${bat}/capacity`))
  const status  = readText(`/sys/class/power_supply/${bat}/status`)?.trim() ?? 'Unknown'
  if (!Number.isFinite(percent)) return null
  const draining = status === 'Discharging'
  return {
    percent, status,
    state: draining && percent <= BATTERY_CRITICAL ? 'critical' : draining && percent <= BATTERY_LOW ? 'low' : 'ok',
  }
}

// ─── the OS's own queue ───────────────────────────────────────────────────

function reboot(readText: (p: string) => string | null): Vitals['reboot'] {
  // The marker lives in /run; Debian keeps it nowhere else, so a machine
  // without /run/reboot-required.pkgs either does not need one or is not Debian.
  const marker = readText('/run/reboot-required') ?? readText('/var/run/reboot-required')
  if (marker === null) return readText('/etc/debian_version') === null ? null : { required: false, packages: [] }
  const pkgs = readText('/run/reboot-required.pkgs') ?? readText('/var/run/reboot-required.pkgs') ?? ''
  return { required: true, packages: [...new Set(pkgs.split('\n').map(s => s.trim()).filter(Boolean))] }
}

function updates(readText: (p: string) => string | null): number | null {
  const text = readText('/var/lib/update-notifier/updates-available')
  if (text === null) return null
  const m = /(\d+) updates? can be applied/.exec(text)
  return m ? Number(m[1]) : 0
}

const round = (n: number) => Math.round(n * 10) / 10
