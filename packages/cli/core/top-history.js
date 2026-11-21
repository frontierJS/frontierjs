// ─── top-history.js — a flight recorder for `fli top` ────────────────────────
//
// systemd-oomd killed a whole VS Code scope (97,842 processes) and nothing had
// recorded which job ate the memory. `fli top --record` samples what the
// hitlist sees every 10 s and appends one compact JSON line per sample to a day
// file; `--at <time>` replays the nearest sample in the hitlist's own layout
// and `--history` prints one line per minute. A recorded kill is an event in
// the sample, read from the systemd-oomd journal.
//
// Plain JS, no dependencies beyond hitlist.js and cgroups.js. Everything that
// touches the machine takes an injectable (`run`, `journal`, `sleep`, `now`,
// the directories), so a test drives it against a tmp dir.

import { appendFileSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { configDir, dataDir } from './paths.js'
import { buildHitlist, finishSample, fmtRate, FORK_HIGH, parseStat, reading, renderHitlist } from './hitlist.js'
import { oomdLimits, readAppGroups } from './cgroups.js'

const MIB = 1024 ** 2
const mib = n => (n == null ? null : Math.round(n / MIB))
const r1 = n => (n == null ? null : Math.round(n * 10) / 10)
const clip = (s, n) => (s.length <= n ? s : s.slice(0, n - 1) + '…')
const pad2 = n => String(n).padStart(2, '0')

// ─── where it lives ──────────────────────────────────────────────────────────

/** `~/.local/share/fli/top/history` — recorded data, not a cache: an incident's samples must outlive a cache wipe. Or $FLI_TOP_HISTORY_DIR. */
export const historyDir = (env = process.env) =>
  env.FLI_TOP_HISTORY_DIR || join(dataDir(), 'top', 'history')

/** `~/.config/systemd/user` — systemd's directory, the sibling of fli's own config root. Or $FLI_TOP_UNIT_DIR. */
export const unitDir = (env = process.env) =>
  env.FLI_TOP_UNIT_DIR || join(dirname(configDir()), 'systemd', 'user')

export const UNIT_NAME = 'fli-top-record.service'

/** The LOCAL calendar date, which is the day file a sample belongs to. */
export const localDate = ts => { const d = new Date(ts); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` }
/** `YYYY-MM-DD HH:MM[:SS]` local. */
export const localTime = (ts, secs = true) => {
  const d = new Date(ts)
  return `${localDate(ts)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}${secs ? ':' + pad2(d.getSeconds()) : ''}`
}
const clock = (ts, secs = true) => localTime(ts, secs).slice(11)

const DAY_FILE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/

// ─── the record ──────────────────────────────────────────────────────────────

/** The jobs worth keeping: the top by memory and the top by CPU, deduped by leader. */
export function pickJobs(jobs, { byMem = 15, byCpu = 5 } = {}) {
  const chosen = new Map()
  for (const j of [...jobs].sort((a, b) => b.rssBytes - a.rssBytes).slice(0, byMem)) chosen.set(j.rootPid, j)
  for (const j of [...jobs].sort((a, b) => b.cpu - a.cpu).filter(j => j.cpu >= 1).slice(0, byCpu)) chosen.set(j.rootPid, j)
  return [...chosen.values()].map(j => ({
    n: clip(j.label, 60), w: clip(j.where ?? '?', 48), p: j.rootPid, c: Math.round(j.cpu), r: mib(j.rssBytes),
    a: Math.round(j.ageSecs), k: j.procs, by: clip(j.startedBy?.text ?? '', 40),
  }))
}

/**
 * One sample as a compact object: what a line of the day file holds. `list` is
 * `buildHitlist` over a sample; `events` the oomd kills seen since the last
 * one; `self` what the recorder itself cost. `ts` is the FIRST key, so a reader
 * can range-filter a day file on a regex without parsing the line.
 */
export function makeRecord(list, { events = [], self = null, groupsTop = 8 } = {}) {
  const { sys, groups } = list
  const pair = k => [r1(sys.stall?.[k]), r1(sys.stallFull?.[k])]
  const rec = {
    ts: list.ts ?? Date.now(),
    cores: sys.cores,
    load: sys.load?.[0] ?? null,
    cpu: Math.round(sys.cpuPct),
    psi: { mem: pair('memory'), cpu: pair('cpu'), io: pair('io') },
    mem: { t: mib(sys.memTotal), u: mib(sys.memUsed), st: mib(sys.swapTotal), su: mib(sys.swapUsed) },
    forks: sys.forkPerMin == null ? null : Math.round(sys.forkPerMin),
    jobs: pickJobs(list.jobs),
  }
  if (groups) {
    const p = groups.parent
    rec.user = p && {
      u: p.unit, m: mib(p.memBytes), s: mib(p.swapBytes), k: p.pids, ps: p.some10, pf: p.full10,
      lim: groups.oomd?.limitPct, dur: groups.oomd?.durationSec, src: groups.oomd?.source, flag: groups.flag ?? null,
    }
    rec.groups = groups.groups.slice(0, groupsTop).map(g => ({
      n: g.friendly, u: clip(g.unit, 80), m: mib(g.memBytes), s: mib(g.swapBytes), pk: mib(g.peakBytes), k: g.pids, ps: g.some10, pf: g.full10,
    }))
  }
  if (events.length) rec.events = events
  if (self) rec.self = self
  return rec
}

/** A record back into what `renderHitlist` takes, so a replay uses the live layout. */
export function recordToList(rec) {
  const total = rec.mem?.t, used = rec.mem?.u
  const sys = {
    cores: rec.cores ?? 1,
    load: [rec.load ?? 0, 0, 0],
    cpuPct: rec.cpu ?? 0,
    memPct: total ? used / total * 100 : 0,
    swapPct: rec.mem?.st ? rec.mem.su / rec.mem.st * 100 : null,
    stall: { memory: rec.psi?.mem?.[0] ?? null, cpu: rec.psi?.cpu?.[0] ?? null, io: rec.psi?.io?.[0] ?? null },
    forkPerMin: rec.forks ?? null,
  }
  const jobs = (rec.jobs ?? []).map(j => ({
    cpu: j.c, share: j.c / sys.cores, rssBytes: j.r * MIB, procs: j.k, ageSecs: j.a, label: j.n, where: j.w,
    startedBy: { kind: j.by?.startsWith('claude') ? 'claude' : 'other', text: j.by ?? '', pid: j.by }, rootPid: j.p,
  }))
  let groups = null
  if (rec.user || rec.groups) {
    const u = rec.user
    groups = {
      parent: u && { unit: u.u, memBytes: u.m * MIB, swapBytes: u.s == null ? null : u.s * MIB, pids: u.k, some10: u.ps, full10: u.pf },
      oomd: u && { limitPct: u.lim, durationSec: u.dur, source: u.src },
      flag: u?.flag ?? null,
      groups: (rec.groups ?? []).map(g => ({
        friendly: g.n, unit: g.u, memBytes: g.m * MIB, swapBytes: g.s == null ? null : g.s * MIB, peakBytes: g.pk == null ? null : g.pk * MIB, pids: g.k, some10: g.ps, full10: g.pf,
      })),
    }
  }
  return { ts: rec.ts, sys, kernelHot: [], jobs, groups }
}

// ─── the day files ───────────────────────────────────────────────────────────

export function appendRecord(dir, rec) {
  mkdirSync(dir, { recursive: true })
  appendFileSync(join(dir, `${localDate(rec.ts)}.jsonl`), JSON.stringify(rec) + '\n')
}

/** Delete day files older than `days` calendar days; returns the names removed. */
export function pruneHistory(dir, { days = 2, now = Date.now() } = {}) {
  let names
  try { names = readdirSync(dir) } catch { return [] }
  const d = new Date(now)
  const keepFrom = localDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() - days).getTime())
  const gone = []
  for (const n of names) {
    if (!DAY_FILE.test(n) || n.slice(0, 10) >= keepFrom) continue
    try { rmSync(join(dir, n)); gone.push(n) } catch {}
  }
  return gone
}

/** The samples whose ts is in [from, to], oldest first. Parses only the lines inside the range. */
export function loadSamples(dir, from, to) {
  const out = []
  const day = new Date(from)
  const last = localDate(to)
  for (let d = new Date(day.getFullYear(), day.getMonth(), day.getDate()); ; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    const name = localDate(d.getTime())
    if (name > last) break
    let text
    try { text = readFileSync(join(dir, `${name}.jsonl`), 'utf8') } catch { continue }
    for (const line of text.split('\n')) {
      const m = /^\{"ts":(\d+)/.exec(line)
      if (!m || +m[1] < from || +m[1] > to) continue
      try { out.push(JSON.parse(line)) } catch {} // a half-written last line
    }
  }
  return out.sort((a, b) => a.ts - b.ts)
}

/** The newest sample's ts in today's file (for the journal window after a restart), or null. */
export function lastSampleTs(dir, now = Date.now()) {
  try {
    const text = readFileSync(join(dir, `${localDate(now)}.jsonl`), 'utf8').trimEnd()
    return Number(/^\{"ts":(\d+)/.exec(text.slice(text.lastIndexOf('\n') + 1))?.[1]) || null
  } catch { return null }
}

// ─── time words ──────────────────────────────────────────────────────────────

const UNIT_MS = { s: 1000, m: 60000, h: 3600000, d: 86400000 }

/**
 * `HH:MM`, `HH:MM:SS` (today, or yesterday if that is still ahead of `now`), an
 * ISO / `YYYY-MM-DD HH:MM` date (local unless it carries an offset), or `-15m`
 * (s, m, h, d) before `now`; the dash is optional, because the argv reader takes
 * a space-separated `-15m` for a short flag — write `--at=-15m` or `--at 15m`. Returns epoch ms; throws an Error that says what
 * was accepted.
 */
export function parseTime(text, now = Date.now()) {
  const s = String(text ?? '').trim()
  let m = s.match(/^-?(\d+(?:\.\d+)?)([smhd])$/)
  if (m) return now - Number(m[1]) * UNIT_MS[m[2]]
  m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (m) {
    const [h, mi, se] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)]
    if (h < 24 && mi < 60 && se < 60) {
      const d = new Date(now)
      let t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, mi, se).getTime()
      if (t > now) t -= UNIT_MS.d
      return t
    }
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const t = new Date(s).getTime()
    if (Number.isFinite(t)) return t
  }
  throw new Error(`cannot read the time "${s}" — use HH:MM, HH:MM:SS, an ISO date (2026-11-21T12:50), or -15m (written --at=-15m or --at 15m)`)
}

/** The sample nearest `ms`, and how far from it. Null on an empty list. */
export function nearestSample(samples, ms) {
  let best = null
  for (const s of samples) {
    const d = Math.abs(s.ts - ms)
    if (!best || d < best.distanceMs) best = { sample: s, distanceMs: d }
  }
  return best
}

// ─── oomd kills ──────────────────────────────────────────────────────────────

const defaultRun = (cmd, args) => {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 5000 })
    return r.status === 0 ? r.stdout : null
  } catch { return null }
}

/** short-iso `2026-11-21T12:50:21-0700` → epoch ms. */
const isoMs = s => Date.parse(s.replace(/([+-]\d\d)(\d\d)$/, '$1:$2'))

/** The `Killed …` lines of a `journalctl -u systemd-oomd -o short-iso` listing, as events. */
export function parseOomdKills(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    const m = line.match(/^(\S+)\s+\S+\s+systemd-oomd\[\d+\]:\s+Killed\s+(\S+)\s*(.*)$/)
    if (!m) continue
    const ts = isoMs(m[1])
    if (Number.isFinite(ts)) out.push({ ts, unit: basename(m[2]), why: clip(m[3], 200) })
  }
  return out
}

/**
 * Kills logged since `since` (epoch ms) that `seen` has not already returned.
 * Silent — an empty list — where journalctl is absent or refuses the user.
 */
export function readOomdKills({ since, seen = new Set(), run = defaultRun } = {}) {
  const out = run('journalctl', ['-u', 'systemd-oomd', '--since', localTime(since), '-o', 'short-iso', '--no-pager', '-q'])
  const fresh = []
  for (const e of parseOomdKills(out)) {
    const key = `${e.ts} ${e.unit}`
    if (seen.has(key)) continue
    seen.add(key)
    fresh.push(e)
  }
  return fresh
}

// ─── the recorder ────────────────────────────────────────────────────────────

/** CPU seconds this process and its reaped children have used (journalctl counts), from /proc/self/stat. */
export function selfCpuSecs(clkTck = 100) {
  try {
    const p = parseStat(readFileSync('/proc/self/stat', 'utf8'))
    return (p.ticks + p.childTicks) / clkTck
  } catch { return 0 }
}

/**
 * Sample every `everyMs` and append to the day file, `iterations` times (forever
 * by default). Each reading is the next one's start, so a sample's CPU is the
 * mean over the whole interval and the process table is read once per sample.
 * Resolves with `{ samples, cpuSecs, wallSecs }` — the recorder's own cost.
 */
export async function recordLoop({
  dir = historyDir(), everyMs = 10000, iterations = Infinity, now = Date.now, keepDays = 2,
  journal = readOomdKills, journalEvery = 3, // every 30 s: a kill carries its own time, so the poll's lateness costs nothing
  sleep = ms => new Promise(r => setTimeout(r, ms)),
  oomd = null, onSample = null, onPrune = null, groups = null,
} = {}) {
  const prune = () => { const gone = pruneHistory(dir, { days: keepDays, now: now() }); if (gone.length) onPrune?.(gone) }
  prune()
  const limits = oomd ?? oomdLimits()
  const seen = new Set()
  let since = lastSampleTs(dir, now()) ?? now()
  let day = localDate(now())
  let prev = reading()
  const cpu0 = selfCpuSecs()
  const wall0 = performance.now()
  let cpuMark = cpu0
  let n = 0
  while (n < iterations) {
    await sleep(everyMs)
    const cur = reading()
    const sample = finishSample(prev, cur, { groups: groups ?? readAppGroups({ oomd: limits }) })
    let events = []
    if (n % journalEvery === 0) {
      events = journal({ since: since - 5000, seen })
      since = now()
    }
    const cpuNow = selfCpuSecs()
    const rec = makeRecord(buildHitlist(sample), {
      events,
      self: { cpuMs: Math.round((cpuNow - cpuMark) * 1000), rssMb: mib(process.memoryUsage().rss) },
    })
    cpuMark = cpuNow
    if (localDate(rec.ts) !== day) { day = localDate(rec.ts); prune() }
    appendRecord(dir, rec)
    prev = cur
    n++
    onSample?.(rec)
  }
  return { samples: n, cpuSecs: selfCpuSecs() - cpu0, wallSecs: (performance.now() - wall0) / 1000 }
}

// ─── the systemd user unit ───────────────────────────────────────────────────

const isTemporary = p => /(^|\/)(\.claude\/worktrees|worktrees)\/|-wt-/.test(p)

/**
 * The fli entry the unit runs: `--bin`, else the GLOBAL `fli` on PATH (resolved
 * through its symlinks to the checkout it points at), else `~/.bun/bin/fli`,
 * else this checkout's own `bin/fli.js` — which is the last resort because a
 * worktree or a tmp checkout is temporary and the unit would outlive it.
 * `warn` says when what was found looks temporary.
 */
export function resolveFliBin({ bin = null, here = null, env = process.env, home = homedir() } = {}) {
  const real = p => { try { return realpathSync(p) } catch { return null } }
  let found = bin ? real(bin) ?? bin : null
  if (!found) {
    // fli puts the project's node_modules/.bin first on PATH, which holds THIS
    // checkout's fli; the global one is the install's own bin directory.
    const dirs = [join(home, '.bun/bin'), ...(env.PATH ?? '').split(delimiter).filter(d => d && !d.includes('node_modules'))]
    const all = dirs.map(d => real(join(d, 'fli'))).filter(Boolean)
    found = all.find(p => !isTemporary(p)) ?? all[0] ?? null
  }
  if (!found && here) found = here
  return { bin: found, warn: found && isTemporary(found) ? `${found} looks temporary (a worktree checkout); the unit stops working when it goes — pass --bin <path to the main checkout's bin/fli.js>` : null }
}

/** The unit's text: one absolute path to bun and one to fli, since a user unit's PATH holds neither. */
export function unitText({ bun, fliBin, historyDirOverride = null, everySecs = null }) {
  return `[Unit]
Description=fli top recorder: memory, app groups and oomd kills every 10s, for \`fli top --at\` and \`--history\`

[Service]
ExecStart=${bun} ${fliBin} top --record${everySecs ? ` --every ${everySecs}` : ''}
${historyDirOverride ? `Environment=FLI_TOP_HISTORY_DIR=${historyDirOverride}\n` : ''}Restart=on-failure
RestartSec=10
Nice=10
IOSchedulingClass=idle

[Install]
WantedBy=default.target
`
}

/** Write the unit into `dir` and return where, plus the command that starts it. Runs nothing. */
export function installUnit({ dir = unitDir(), bun = process.execPath, fliBin, env = process.env } = {}) {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, UNIT_NAME)
  writeFileSync(file, unitText({ bun: realpathSync(bun), fliBin, historyDirOverride: env.FLI_TOP_HISTORY_DIR || null }))
  return { file, enable: `systemctl --user daemon-reload && systemctl --user enable --now ${UNIT_NAME}` }
}

// ─── history ─────────────────────────────────────────────────────────────────

/** One row per local minute: max memory pressure and fork rate, last mem/swap, the heaviest group and job, kills. */
export function aggregateHistory(samples, { from = -Infinity, to = Infinity } = {}) {
  const rows = new Map()
  const row = ts => {
    const key = Math.floor(ts / 60000) * 60000
    if (!rows.has(key)) rows.set(key, { minute: key, samples: 0, psiMax: null, forksMax: null, memUsed: null, memTotal: null, swapUsed: null, group: null, job: null, kills: [] })
    return rows.get(key)
  }
  const max = (a, b) => (b == null ? a : a == null ? b : Math.max(a, b))
  for (const s of samples) {
    if (s.ts >= from && s.ts <= to) {
      const r = row(s.ts)
      r.samples++
      r.psiMax = max(r.psiMax, s.psi?.mem?.[0])
      r.forksMax = max(r.forksMax, s.forks)
      r.memUsed = s.mem?.u ?? r.memUsed
      r.memTotal = s.mem?.t ?? r.memTotal
      r.swapUsed = s.mem?.su ?? r.swapUsed
      const g = s.groups?.[0]
      if (g && (!r.group || g.m > r.group.m)) r.group = { n: g.n, m: g.m }
      const j = [...(s.jobs ?? [])].sort((a, b) => b.r - a.r)[0]
      if (j && (!r.job || j.r > r.job.r)) r.job = { n: j.n, r: j.r }
    }
    // a kill belongs to the minute it happened in, not the one whose sample noticed it
    for (const e of s.events ?? []) if (e.ts >= from && e.ts <= to) row(e.ts).kills.push(e)
  }
  return [...rows.values()].sort((a, b) => a.minute - b.minute)
}

const fmtMib = n => (n == null ? '-' : n >= 1024 ? `${(n / 1024).toFixed(1)}G` : `${n}M`)

/** `--history` as lines. */
export function renderHistory(rows, { c, width = 120, from, to } = {}) {
  if (!rows.length) return [`no samples between ${localTime(from, false)} and ${localTime(to, false)} — is \`fli top --record\` running?`]
  const lines = []
  lines.push(c.dim(`${'TIME'.padEnd(5)} ${'MEM PSI'.padStart(7)} ${'FORKS/MIN'.padStart(9)} ${'MEM USED'.padStart(13)} ${'SWAP'.padStart(6)}  ${'TOP GROUP'.padEnd(20)} TOP JOB`))
  let prev = null
  for (const r of rows) {
    if (prev != null && r.minute - prev > 90000) lines.push(c.dim(`  … no samples for ${Math.round((r.minute - prev) / 60000) - 1}m`))
    prev = r.minute
    const psi = r.psiMax == null ? '-' : `${Math.round(r.psiMax)}%`
    const forks = r.forksMax == null ? '-' : fmtRate(r.forksMax)
    const mem = r.memUsed == null ? '-' : `${fmtMib(r.memUsed)}/${fmtMib(r.memTotal)}`
    const group = r.group ? `${r.group.n} ${fmtMib(r.group.m)}` : '-'
    const job = r.job ? `${r.job.n} ${fmtMib(r.job.r)}` : '-'
    const kill = r.kills.length ? c.red(`  KILLED ${r.kills.map(k => k.unit).join(', ')}`) : ''
    const line = `${clock(r.minute, false)} ${(r.psiMax >= 30 ? c.yellow : s => s)(psi.padStart(7))} ${(r.forksMax > FORK_HIGH ? c.red : s => s)(forks.padStart(9))} ${mem.padStart(13)} ${fmtMib(r.swapUsed).padStart(6)}  ${clip(group, 20).padEnd(20)} ${clip(job, Math.max(width - 66, 16))}${kill}`
    lines.push(line)
  }
  return lines
}

/** `--at`: the hitlist layout over a recorded sample, labelled with its real time, plus kills nearby. */
export function renderAt({ sample, requested, distanceMs, kills = [] }, { c, width = 120 } = {}) {
  const off = distanceMs >= 1000 ? ` — nearest to ${clock(requested)}, ${Math.round(distanceMs / 1000)}s ${sample.ts < requested ? 'before' : 'after'}` : ''
  const lines = renderHitlist(recordToList(sample), { width, c, sort: 'rss', minCpu: 0, title: `fli top at ${localTime(sample.ts)} (recorded)${off}` })
  lines.push('')
  if (kills.length) for (const k of kills) lines.push(c.red(`oomd killed ${k.unit} at ${clock(k.ts)}`) + c.dim(` — ${k.why}`))
  else lines.push(c.dim('no oomd kills within 2 min of this sample'))
  return lines
}

/** The kills within `windowMs` of `ts`, from samples around it. */
export function killsNear(samples, ts, windowMs = 120000) {
  const seen = new Map()
  for (const s of samples) for (const e of s.events ?? []) if (Math.abs(e.ts - ts) <= windowMs) seen.set(`${e.ts} ${e.unit}`, e)
  return [...seen.values()].sort((a, b) => a.ts - b.ts)
}

/** Load around `ms`, find the nearest sample and the kills near it. Null where nothing is recorded. */
export function lookupAt(dir, ms, { windowMs = 120000, reach = 15 * 60000 } = {}) {
  const near = nearestSample(loadSamples(dir, ms - reach, ms + reach), ms)
  if (!near) return null
  // events are written into the sample that noticed them, up to a poll later
  const around = loadSamples(dir, near.sample.ts - windowMs - 60000, near.sample.ts + windowMs + 60000)
  return { ...near, requested: ms, kills: killsNear(around, near.sample.ts, windowMs) }
}
