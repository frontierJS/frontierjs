// `fli top`'s app groups, fork rate, recorder and replay. The cgroup reader runs
// over a fake tree in a tmp dir, the clock and the journal are handed in, and
// nothing here writes outside the tmp dir it makes.

import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCgroups, friendlyName, parsePressure, oomdLimits, limitPct, confDuration, pressureFlag, readAppGroups } from '../core/cgroups.js'
import { forksPerMin, renderHitlist } from '../core/hitlist.js'
import {
  makeRecord, recordToList, pruneHistory, appendRecord, loadSamples, lastSampleTs, parseTime, nearestSample, lookupAt,
  aggregateHistory, renderHistory, renderAt, installUnit, unitText, resolveFliBin, parseOomdKills, readOomdKills, recordLoop, localDate, UNIT_NAME,
} from '../core/top-history.js'

const plain = new Proxy({}, { get: () => s => String(s) })
let tmp
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'fli-top-history-')) })
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

const put = (path, text) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text) }
const MIB = 1024 ** 2
const at = (h, m, s = 0, day = 21) => new Date(2026, 10, day, h, m, s).getTime()

/** A fake /sys/fs/cgroup with the unit shapes the real one has. */
function fakeTree(root, uid = 1000) {
  const base = join(root, 'user.slice', `user-${uid}.slice`, `user@${uid}.service`)
  const unit = (rel, { mem, swap, peak, pids, some = 0, full = 0 }) => {
    const d = join(base, rel)
    if (mem != null) put(join(d, 'memory.current'), `${mem}\n`)
    if (swap != null) put(join(d, 'memory.swap.current'), `${swap}\n`)
    if (peak != null) put(join(d, 'memory.peak'), `${peak}\n`)
    if (pids != null) put(join(d, 'pids.current'), `${pids}\n`)
    put(join(d, 'memory.pressure'), `some avg10=${some} avg60=0.00 avg300=0.00 total=1\nfull avg10=${full} avg60=0.00 avg300=0.00 total=1\n`)
  }
  unit('.', { mem: 20e9, swap: 1e9, pids: 98000, some: 71.5, full: 40 })
  unit('app.slice/app-com.microsoft.VSCode-27762.scope', { mem: 9e9, swap: 5e8, peak: 12e9, pids: 97842, some: 66, full: 30 })
  unit('app.slice/app-gnome-google\\x2dchrome-7362.scope', { mem: 4e9, pids: 500 }) // no swap file, no peak
  unit('app.slice/app-org.gnome.Terminal.slice', { mem: 1e9, pids: 20 })
  unit('app.slice/app-org.gnome.Terminal.slice/tmux-spawn-abc.scope', { mem: 9e8, pids: 5 }) // inside a slice: not walked
  unit('session.slice/session-3.scope', { mem: 2e9, pids: 40 })
  unit('dbus.service', { mem: 3e6, pids: 1 })
  put(join(base, 'app.slice/app-gnome-update\\x2dnotifier-8317.scope/pids.current'), '3\n') // no memory.current: skipped
  return base
}

describe('cgroups', () => {
  test('reads the user units, heaviest first, and the parent oomd judges', () => {
    fakeTree(tmp)
    const { parent, groups } = readCgroups({ root: tmp, uid: 1000 })
    expect(parent).toMatchObject({ unit: 'user@1000.service', memBytes: 20e9, swapBytes: 1e9, pids: 98000, some10: 71.5, full10: 40 })
    expect(groups.map(g => g.friendly)).toEqual(['VSCode', 'Chrome', 'login session 3', 'Terminal', 'dbus'])
    expect(groups[0]).toMatchObject({ unit: 'app-com.microsoft.VSCode-27762.scope', slice: 'app.slice', memBytes: 9e9, swapBytes: 5e8, peakBytes: 12e9, pids: 97842, some10: 66, full10: 30 })
  })

  test('a missing file is a null, never a throw', () => {
    fakeTree(tmp)
    const chrome = readCgroups({ root: tmp, uid: 1000 }).groups.find(g => g.friendly === 'Chrome')
    expect(chrome.swapBytes).toBeNull()
    expect(chrome.peakBytes).toBeNull()
    expect(chrome.some10).toBe(0)
  })

  test('no cgroup v2 tree, or another user, reads as nothing', () => {
    expect(readCgroups({ root: join(tmp, 'absent'), uid: 1000 })).toEqual({ parent: null, groups: [] })
    fakeTree(tmp)
    expect(readCgroups({ root: tmp, uid: 4242 })).toEqual({ parent: null, groups: [] })
    expect(readAppGroups({ root: join(tmp, 'absent'), uid: 1000 })).toBeNull()
  })

  test('friendly names', () => {
    expect(friendlyName('app-com.microsoft.VSCode-27762.scope')).toBe('VSCode')
    expect(friendlyName('app-gnome-google\\x2dchrome-7362.scope')).toBe('Chrome')
    expect(friendlyName('app-com.google.Chrome-7362.scope')).toBe('Chrome')
    expect(friendlyName('app-gnome-ProtonMail\\x20Bridge-6385.scope')).toBe('ProtonMail Bridge')
    expect(friendlyName('app-org.gnome.Terminal.slice')).toBe('Terminal')
    expect(friendlyName('app-gnome-my.workbench.desktop-249221.scope')).toBe('workbench')
    expect(friendlyName('tmux-spawn-6f1f5dd3-4a9b-4a64-96ea-7b6cdd9a3e2c.scope')).toBe('tmux')
    expect(friendlyName('snap.firefox.firefox-e6a7060f-7df4-42bd-92b8-5b19dbb8c59a.scope')).toBe('Firefox')
    expect(friendlyName('dbus.service')).toBe('dbus')
    expect(friendlyName('at-spi-dbus-bus.service')).toBe('at-spi-dbus-bus')
  })

  test('pressure parses some and full, and an empty file is nulls', () => {
    expect(parsePressure('some avg10=1.50 avg60=0 avg300=0 total=1\nfull avg10=0.25 avg60=0 avg300=0 total=1')).toEqual({ some: 1.5, full: 0.25 })
    expect(parsePressure('')).toEqual({ some: null, full: null })
  })

  test('the oomd limit: systemctl, else oomd.conf, else the assumed 50% for 20s', () => {
    expect(limitPct('2147483648')).toBe(50)
    expect(limitPct('0')).toBeNull()
    expect(confDuration('[OOM]\nDefaultMemoryPressureDurationSec=30s\n')).toBe(30)
    expect(confDuration('[OOM]\n#DefaultMemoryPressureDurationSec=30s\n')).toBeNull()
    const conf = join(tmp, 'oomd.conf')
    expect(oomdLimits({ run: () => '2147483648', confPath: conf })).toEqual({ limitPct: 50, durationSec: 20, source: 'systemctl' })
    expect(oomdLimits({ run: () => null, confPath: conf })).toEqual({ limitPct: 50, durationSec: 20, source: 'assumed' })
    writeFileSync(conf, '[OOM]\nDefaultMemoryPressureLimit=60%\nDefaultMemoryPressureDurationSec=1min\n')
    expect(oomdLimits({ run: () => '0', confPath: conf })).toEqual({ limitPct: 60, durationSec: 60, source: 'oomd.conf' })
  })

  test('pressure is flagged near (past 60% of the limit) and over', () => {
    expect(pressureFlag(10, 50)).toBeNull()
    expect(pressureFlag(30, 50)).toBe('near')
    expect(pressureFlag(50, 50)).toBe('over')
    expect(pressureFlag(null, 50)).toBeNull()
  })
})

describe('a reparented orphan', () => {
  test('its exit is charged to the ancestor that reaps it, not read as that ancestor\'s whole-life CPU', async () => {
    const { buildHitlist } = await import('../core/hitlist.js')
    const p = (pid, ppid, comm, ticks, childTicks = 0) => ({ pid, ppid, pgid: pid, comm, args: [comm], ticks, childTicks, start: 1, rssPages: 1, cwd: '/home/u' })
    // 50 was a child of 40; 40 died, 50 was reparented to the user manager (10) and died too, having used 5000 ticks before the window and 100 in it
    const before = [p(1, 0, 'systemd', 0), p(10, 1, 'systemd', 0, 0), p(40, 10, 'bash', 0), p(50, 40, 'node', 5000)]
    const after = [p(1, 0, 'systemd', 0), p(10, 1, 'systemd', 0, 5100)]
    const m = l => new Map(l.map(x => [x.pid, x]))
    const { jobs } = buildHitlist({ before: m(before), after: m(after), elapsedMs: 10000, clkTck: 100, pageSize: 4096, selfPid: 9, home: '/home/u', sys: { cores: 4, uptime: 100 } })
    const cpu = jobs.reduce((a, j) => a + j.cpu, 0)
    expect(Math.round(cpu)).toBe(10) // 100 ticks over 10 s, not 5100
  })
})

describe('fork rate', () => {
  test('is the counter delta per minute', () => {
    expect(forksPerMin(1000, 1077, 1000)).toBeCloseTo(4620)
    expect(forksPerMin(1000, 1010, 10000)).toBeCloseTo(60)
  })
  test('is null when a counter or the time is missing, and never negative', () => {
    expect(forksPerMin(null, 5, 1000)).toBeNull()
    expect(forksPerMin(5, 9, 0)).toBeNull()
    expect(forksPerMin(9, 5, 1000)).toBe(0)
  })
})

// a list shaped like buildHitlist's, with the volume a bad hour has
function bigList(ts) {
  const jobs = Array.from({ length: 80 }, (_, i) => ({
    cpu: i % 7, share: 1, rssBytes: (i + 1) * 40 * MIB, procs: i + 1, ageSecs: 3600 + i, label: `bun run --filter * typecheck → tsc ×${i}`.padEnd(70, 'x'),
    where: `~/code/FRONTIER/frontierjs-wt-top/packages/some-long-package-name-${i}`, startedBy: { kind: 'claude', text: `claude frontierjs ${20000 + i} vscode` }, rootPid: 1000 + i, stop: 'kill',
  }))
  const groups = Array.from({ length: 30 }, (_, i) => ({
    friendly: `App${i}`, unit: `app-com.example.App${i}-${i}.scope`.padEnd(90, 'y'), memBytes: (30 - i) * 100 * MIB, swapBytes: i * MIB, peakBytes: 40 * 100 * MIB, pids: 100 + i, some10: 1.5, full10: 0.5,
  }))
  return {
    ts,
    sys: { cores: 12, load: [7.5, 3, 2], cpuPct: 41.3, memPct: 80, swapPct: 3, memTotal: 100e9, memUsed: 80e9, swapTotal: 16e9, swapUsed: 5e8, stall: { cpu: 1, memory: 71.5, io: 3 }, stallFull: { cpu: 0, memory: 40, io: 1 }, forkPerMin: 4620 },
    kernelHot: [], jobs,
    groups: { parent: { unit: 'user@1000.service', memBytes: 20e9, swapBytes: 1e9, pids: 98000, some10: 71.5, full10: 40 }, groups, oomd: { limitPct: 50, durationSec: 20, source: 'systemctl' }, flag: 'over' },
  }
}

describe('the record', () => {
  test('stays under 8 KB with ts first, even for a crowded machine', () => {
    const rec = makeRecord(bigList(at(12, 50)), { events: [{ ts: at(12, 50, 21), unit: 'app-com.microsoft.VSCode-27762.scope', why: 'x'.repeat(200) }], self: { cpuMs: 30, rssMb: 90 } })
    const line = JSON.stringify(rec)
    expect(line.length).toBeLessThan(8000)
    expect(line.startsWith(`{"ts":${at(12, 50)},`)).toBe(true)
    expect(rec.jobs.length).toBeLessThanOrEqual(20)
    expect(rec.groups.length).toBe(8)
    expect(rec.psi.mem).toEqual([71.5, 40])
    expect(rec.forks).toBe(4620)
  })

  test('keeps the top 15 by memory and 5 by CPU, once each', () => {
    const rec = makeRecord(bigList(at(12, 50)))
    const pids = rec.jobs.map(j => j.p)
    expect(new Set(pids).size).toBe(pids.length)
    expect(pids).toContain(1079) // the heaviest by memory
    expect(rec.jobs.filter(j => j.r >= 66 * 40).length).toBe(15)
  })

  test('replays through the live layout: head line, jobs by memory, groups, the over-limit line', () => {
    const rec = makeRecord(bigList(at(12, 50)))
    const text = renderHitlist(recordToList(rec), { c: plain, width: 140, sort: 'rss', minCpu: 0, title: 't' }).join('\n')
    expect(text).toContain('forks 4.6k/min HIGH')
    expect(text).toContain('stalled: memory 72%')
    expect(text).toMatch(/OVER THE LIMIT/)
    expect(text).toMatch(/App0 +app-com\.example\.App0/)
    expect(text).not.toContain('stop #')
  })
})

describe('the day files', () => {
  const rec = (ts, extra = {}) => ({ ts, psi: { mem: [1, 0] }, mem: { t: 1000, u: 500, st: 100, su: 10 }, forks: 100, jobs: [], ...extra })

  test('append writes one line per sample into the local-date file', () => {
    appendRecord(tmp, rec(at(23, 59, 50)))
    appendRecord(tmp, rec(at(0, 0, 10, 22)))
    expect(readdirSync(tmp).sort()).toEqual(['2026-11-21.jsonl', '2026-11-22.jsonl'])
    expect(readFileSync(join(tmp, '2026-11-21.jsonl'), 'utf8').trim().split('\n').length).toBe(1)
    expect(lastSampleTs(tmp, at(23, 59, 59))).toBe(at(23, 59, 50))
  })

  test('prune deletes day files older than two days and nothing else', () => {
    for (const n of ['2026-11-17', '2026-11-18', '2026-11-19', '2026-11-21']) writeFileSync(join(tmp, `${n}.jsonl`), '{}\n')
    writeFileSync(join(tmp, 'notes.txt'), 'keep')
    expect(pruneHistory(tmp, { days: 2, now: at(12, 0) }).sort()).toEqual(['2026-11-17.jsonl', '2026-11-18.jsonl'])
    expect(readdirSync(tmp).sort()).toEqual(['2026-11-19.jsonl', '2026-11-21.jsonl', 'notes.txt'])
    expect(pruneHistory(join(tmp, 'absent'))).toEqual([])
  })

  test('loadSamples reads a range across days and skips a torn line', () => {
    appendRecord(tmp, rec(at(23, 58)))
    appendRecord(tmp, rec(at(0, 2, 0, 22)))
    appendFileTorn(join(tmp, '2026-11-22.jsonl'))
    const got = loadSamples(tmp, at(23, 0), at(1, 0, 0, 22))
    expect(got.map(s => s.ts)).toEqual([at(23, 58), at(0, 2, 0, 22)])
  })
})
function appendFileTorn(file) { writeFileSync(file, readFileSync(file, 'utf8') + '{"ts":1795300000000,"ps') }

describe('time words', () => {
  const now = at(13, 0, 30)
  test('HH:MM and HH:MM:SS are today, or yesterday when still ahead', () => {
    expect(parseTime('12:50', now)).toBe(at(12, 50))
    expect(parseTime('9:05:07', now)).toBe(at(9, 5, 7))
    expect(parseTime('14:00', now)).toBe(at(14, 0, 0, 20))
  })
  test('relative: -15m, -2h, -90s, -1d', () => {
    expect(parseTime('-15m', now)).toBe(now - 15 * 60000)
    expect(parseTime('-2h', now)).toBe(now - 2 * 3600000)
    expect(parseTime('-90s', now)).toBe(now - 90000)
    expect(parseTime('-1d', now)).toBe(now - 86400000)
    expect(parseTime('15m', now)).toBe(now - 15 * 60000) // the dashless spelling, which the argv reader lets through after a flag
  })
  test('ISO, local or with an offset', () => {
    expect(parseTime('2026-11-21T12:50', now)).toBe(at(12, 50))
    expect(parseTime('2026-11-21 12:50:21', now)).toBe(at(12, 50, 21))
    expect(parseTime('2026-11-21T12:50:21-07:00', now)).toBe(Date.parse('2026-11-21T19:50:21Z'))
  })
  test('anything else says what is accepted', () => {
    expect(() => parseTime('noon', now)).toThrow(/HH:MM.*-15m/)
    expect(() => parseTime('25:00', now)).toThrow()
    expect(() => parseTime('', now)).toThrow()
  })
})

describe('--at lookup and --history', () => {
  const mk = (ts, over = {}) => ({
    ts, cores: 12, load: 1, cpu: 5, psi: { mem: [10, 1], cpu: [0, 0], io: [0, 0] }, mem: { t: 100000, u: 40000, st: 16000, su: 100 }, forks: 300,
    jobs: [{ n: 'bun test', w: '~/x', p: 9, c: 50, r: 3000, a: 60, k: 4, by: 'shell 5 vscode' }],
    groups: [{ n: 'VSCode', u: 'app-com.microsoft.VSCode-27762.scope', m: 9000, s: 0, pk: 9500, k: 800, ps: 5, pf: 1 }], ...over,
  })

  test('nearest sample wins, with its distance, across a day boundary', () => {
    for (const ts of [at(12, 49, 50), at(12, 50, 0), at(12, 50, 10), at(12, 55)]) appendRecord(tmp, mk(ts))
    const found = lookupAt(tmp, at(12, 50, 7))
    expect(found.sample.ts).toBe(at(12, 50, 10))
    expect(found.distanceMs).toBe(3000)
    expect(lookupAt(tmp, at(10, 0))).toBeNull() // nothing within 15 min
    expect(nearestSample([], 5)).toBeNull()
  })

  test('kills within 2 min of the sample come with it, and others do not', () => {
    const kill = { ts: at(12, 50, 21), unit: 'app-com.microsoft.VSCode-27762.scope', why: 'memory pressure 71.51% > 50.00%' }
    appendRecord(tmp, mk(at(12, 50, 0)))
    appendRecord(tmp, mk(at(12, 50, 30), { events: [kill] }))
    appendRecord(tmp, mk(at(12, 59, 0), { events: [{ ts: at(12, 58, 50), unit: 'far.scope', why: '' }] }))
    const found = lookupAt(tmp, at(12, 50, 0))
    expect(found.kills).toEqual([kill])
    const out = renderAt(found, { c: plain, width: 120 }).join('\n')
    expect(out).toContain('fli top at 2026-11-21 12:50:00 (recorded)')
    expect(out).toContain('oomd killed app-com.microsoft.VSCode-27762.scope at 12:50:21')
    expect(out).toContain('VSCode')
    expect(out).toContain('bun test')
  })

  test('a distant sample is labelled with its real time', () => {
    appendRecord(tmp, mk(at(12, 50, 0)))
    const found = lookupAt(tmp, at(12, 52, 0))
    expect(renderAt(found, { c: plain }).join('\n')).toMatch(/fli top at 2026-11-21 12:50:00 \(recorded\) — nearest to 12:52:00, 120s before/)
  })

  test('history is one row per minute: max pressure and forks, last memory, heaviest group and job, kills in their own minute', () => {
    const samples = [
      mk(at(12, 49, 5), { psi: { mem: [5, 0] }, forks: 100 }),
      mk(at(12, 49, 15), { psi: { mem: [40, 0] }, forks: 4700, mem: { t: 100000, u: 60000, st: 16000, su: 900 } }),
      mk(at(12, 49, 25), { psi: { mem: [20, 0] }, forks: 900, mem: { t: 100000, u: 50000, st: 16000, su: 800 } }),
      mk(at(12, 50, 5), { jobs: [{ n: 'big', w: '', p: 1, c: 1, r: 9999, a: 1, k: 1, by: '' }], events: [{ ts: at(12, 49, 55), unit: 'v.scope', why: '' }] }),
    ]
    const rows = aggregateHistory(samples)
    expect(rows.length).toBe(2)
    expect(rows[0]).toMatchObject({ minute: at(12, 49), samples: 3, psiMax: 40, forksMax: 4700, memUsed: 50000, swapUsed: 800 })
    expect(rows[0].kills.map(k => k.unit)).toEqual(['v.scope'])
    expect(rows[0].group).toEqual({ n: 'VSCode', m: 9000 })
    expect(rows[1].job).toEqual({ n: 'big', r: 9999 })
    expect(rows[1].kills).toEqual([])
    const text = renderHistory(rows, { c: plain, width: 120, from: at(12, 0), to: at(13, 0) }).join('\n')
    expect(text).toMatch(/^12:49 +40% +4\.7k +48\.8G\/97\.7G/m)
    expect(text).toContain('KILLED v.scope')
    expect(text).toContain('VSCode 8.8G')
  })

  test('the range filter drops samples outside it, and an empty range says how to start recording', () => {
    const rows = aggregateHistory([mk(at(12, 0)), mk(at(13, 0))], { from: at(12, 30), to: at(14, 0) })
    expect(rows.map(r => r.minute)).toEqual([at(13, 0)])
    expect(renderHistory([], { c: plain, from: at(12, 0), to: at(13, 0) })[0]).toMatch(/no samples.*fli top --record/)
  })
})

describe('oomd kills from the journal', () => {
  const line = '2026-11-21T12:50:21-0700 precision systemd-oomd[2033117]: Killed /user.slice/user-1000.slice/user@1000.service/app.slice/app-com.microsoft.VSCode-27762.scope due to memory pressure for /user.slice/user-1000.slice/user@1000.service being 71.51% > 50.00% for > 20s with reclaim activity'

  test('parses the Killed line and ignores the rest', () => {
    const ev = parseOomdKills(`-- Boot abc --\n2026-11-21T12:50:20-0700 precision systemd-oomd[2033117]: Considered 5 cgroups for killing\n${line}\n`)
    expect(ev).toEqual([{ ts: Date.parse('2026-11-21T12:50:21-07:00'), unit: 'app-com.microsoft.VSCode-27762.scope', why: expect.stringContaining('memory pressure for') }])
  })

  test('returns a kill once, and is silent when journalctl is unavailable', () => {
    const seen = new Set()
    const run = () => line
    expect(readOomdKills({ since: 0, seen, run }).length).toBe(1)
    expect(readOomdKills({ since: 0, seen, run }).length).toBe(0)
    expect(readOomdKills({ since: 0, run: () => null })).toEqual([])
  })
})

describe('the systemd user unit', () => {
  test('is written into the directory it is given, and nothing is enabled', () => {
    const dir = join(tmp, 'units')
    const { file, enable } = installUnit({ dir, bun: process.execPath, fliBin: '/opt/frontierjs/packages/cli/bin/fli.js', env: {} })
    expect(file).toBe(join(dir, UNIT_NAME))
    const text = readFileSync(file, 'utf8')
    expect(text).toMatch(new RegExp(`^ExecStart=/\\S*bun\\S* /opt/frontierjs/packages/cli/bin/fli.js top --record$`, 'm'))
    for (const k of ['Restart=on-failure', 'Nice=10', 'IOSchedulingClass=idle', 'WantedBy=default.target']) expect(text).toContain(k)
    expect(enable).toContain(`systemctl --user enable --now ${UNIT_NAME}`)
    expect(readdirSync(tmp)).toEqual(['units'])
  })

  test('carries a history directory override, and an interval', () => {
    const text = unitText({ bun: '/b/bun', fliBin: '/f/fli.js', historyDirOverride: '/data/h', everySecs: 5 })
    expect(text).toContain('Environment=FLI_TOP_HISTORY_DIR=/data/h')
    expect(text).toContain('ExecStart=/b/bun /f/fli.js top --record --every 5')
  })

  test('the entry is the global fli resolved through its symlink, else --bin; a worktree is warned about', () => {
    const real = join(tmp, 'main/packages/cli/bin/fli.js')
    put(real, '#!/usr/bin/env bun\n')
    mkdirSync(join(tmp, 'binroot'))
    symlinkSync(real, join(tmp, 'binroot/fli'))
    expect(resolveFliBin({ env: { PATH: join(tmp, 'binroot') }, home: join(tmp, 'nohome') })).toEqual({ bin: realpathSync(real), warn: null })
    expect(resolveFliBin({ bin: real, env: { PATH: '' } }).bin).toBe(realpathSync(real))
    const wt = resolveFliBin({ env: { PATH: '' }, home: join(tmp, 'nohome'), here: '/home/u/code/frontierjs-wt-top/packages/cli/bin/fli.js' })
    expect(wt.warn).toMatch(/looks temporary/)
  })
})

describe.skipIf(process.platform !== 'linux')('the recorder loop', () => {
  test('appends one parseable, small line per sample, prunes, and reports its own cost', async () => {
    const dir = join(tmp, 'history')
    mkdirSync(dir)
    writeFileSync(join(dir, '2020-01-01.jsonl'), '{}\n')
    const pruned = []
    const kill = { ts: Date.now(), unit: 'x.scope', why: 'test' }
    let polls = 0
    const out = await recordLoop({
      dir, everyMs: 30, iterations: 2, journalEvery: 1, sleep: ms => new Promise(r => setTimeout(r, ms)), onPrune: g => pruned.push(...g),
      oomd: { limitPct: 50, durationSec: 20, source: 'assumed' },
      journal: () => (polls++ === 1 ? [kill] : []),
    })
    expect(out.samples).toBe(2)
    expect(pruned).toEqual(['2020-01-01.jsonl'])
    const file = join(dir, `${localDate(Date.now())}.jsonl`)
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines.length).toBe(2)
    for (const l of lines) {
      expect(l.length).toBeLessThan(8000)
      const rec = JSON.parse(l)
      expect(rec.mem.t).toBeGreaterThan(0)
      expect(rec.self.cpuMs).toBeGreaterThanOrEqual(0)
      expect(Array.isArray(rec.jobs)).toBe(true)
    }
    expect(JSON.parse(lines[1]).events).toEqual([kill])
    expect(existsSync(join(dir, '2020-01-01.jsonl'))).toBe(false)
    expect(out.cpuSecs).toBeGreaterThanOrEqual(0)
  })
})
