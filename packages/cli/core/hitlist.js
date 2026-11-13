// ─── hitlist.js — what is maxing the machine, on one screen ──────────────────
//
// `fli top --hitlist`. `fli top` groups by process NAME, and a CPU spike from a
// build reads there as `node 540%`: twenty `tsc` workers under one row, with
// nothing saying which repo, which command fanned them out, or which Claude
// session started it. This groups by JOB instead — every process folded up to
// the command a launcher (a Claude session, an interactive shell, the desktop,
// systemd) started — and says where it runs and who started it.
//
// A process GROUP is not the job. Claude's own processes share gnome-shell's
// group, and a `bun` child spawned detached owns a group of its own, so grouping
// by pgid both merged unrelated work and split one command's workers. The tree
// up to the nearest launcher is what a person means by "that build".
//
// A build churns: `tsc` and `vitest` workers live for a second and are gone, so
// a process that exits inside the sample window takes its CPU with it. The
// parent's reaped-children time (`cutime`/`cstime`) brings it back, minus what
// those children had already used before the window opened.
//
// Read once, sampled twice, printed, exited: a one-shot does not need the
// native monitor's redraw budget, so this is plain JS over /proc.

import { readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'

const SHELLS = new Set(['bash', 'sh', 'dash', 'zsh', 'fish', 'ksh'])
// A wrapper runs one real command; the job is named after that command.
const WRAPPERS = new Set(['timeout', 'env', 'nice', 'nohup', 'xargs', 'sudo', 'time', 'setsid', 'stdbuf', 'ionice'])
const RUNTIMES = new Set(['node', 'bun', 'deno', 'python', 'python3', 'ruby', 'perl', 'java', 'npx', 'bunx', 'tsx'])
// A runtime flag that takes the next argument as its value, so the script is after it.
const VALUE_FLAGS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--env-file', '--cwd', '--preload', '-m', '-c'])
const DESKTOP = new Set(['gnome-shell', 'plasmashell', 'kwin_x11', 'kwin_wayland', 'xfce4-session', 'sway', 'Hyprland', 'i3', 'cinnamon', 'mutter'])
const TERMINALS = new Set(['gnome-terminal-', 'kitty', 'alacritty', 'wezterm-gui', 'konsole', 'xterm', 'foot', 'tilix', 'terminator', 'xfce4-terminal', 'ghostty', 'tmux: server', 'screen', 'SCREEN', 'zellij'])
const EDITORS = new Set(['code', 'code-insiders', 'cursor', 'codium', 'windsurf', 'zed'])
// Kernel threads whose CPU means memory is being reclaimed, not computed on.
const RECLAIM = /^(kswapd|kcompactd)/

const basename = s => String(s).replace(/\/+$/, '').split('/').pop()

// ─── reading /proc ───────────────────────────────────────────────────────────

/** One /proc/<pid>/stat, parsed. The comm may hold spaces and parens, so the fields start after the LAST ')'. */
export function parseStat(text) {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  const f = text.slice(close + 2).split(' ')
  return {
    pid: Number(text.slice(0, open)),
    comm: text.slice(open + 1, close),
    state: f[0],
    ppid: Number(f[1]),
    pgid: Number(f[2]),
    ticks: Number(f[11]) + Number(f[12]),
    childTicks: Number(f[13]) + Number(f[14]),
    start: Number(f[19]),
    rssPages: Number(f[21]),
  }
}

const readOr = (path, fallback) => { try { return readFileSync(path, 'utf8') } catch { return fallback } }

/** Every process now: Map pid → { pid, comm, ppid, pgid, ticks, childTicks, start, rssPages, args, cwd }. */
export function readProcs({ withDetail = false } = {}) {
  const procs = new Map()
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    const stat = readOr(`/proc/${name}/stat`, null)
    if (!stat) continue // exited between the listing and the read
    const p = parseStat(stat)
    if (withDetail) {
      p.args = readOr(`/proc/${name}/cmdline`, '').split('\0').filter(Boolean)
      try { p.cwd = readlinkSync(`/proc/${name}/cwd`) } catch { p.cwd = null } // another user's process
    }
    procs.set(p.pid, p)
  }
  return procs
}

const cpuTotals = () => {
  const [, ...n] = readOr('/proc/stat', 'cpu 0 0 0 0').split('\n')[0].trim().split(/\s+/).map(Number)
  const total = n.reduce((a, b) => a + b, 0)
  return { total, idle: (n[3] ?? 0) + (n[4] ?? 0) }
}

const meminfo = () => {
  const m = {}
  for (const line of readOr('/proc/meminfo', '').split('\n')) {
    const [k, v] = line.split(':')
    if (v) m[k] = parseInt(v, 10) * 1024
  }
  return m
}

const pressure = what => {
  const m = readOr(`/proc/pressure/${what}`, '').match(/some avg10=([\d.]+)/)
  return m ? Number(m[1]) : null
}

const getconf = (name, fallback) => {
  const r = spawnSync('getconf', [name], { encoding: 'utf8' })
  return Number(r.stdout?.trim()) || fallback
}

/** Two reads `ms` apart, and the machine-wide numbers around them. */
export async function sample(ms = 1000) {
  const cpu0 = cpuTotals()
  const before = readProcs()
  const t0 = performance.now()
  await new Promise(r => setTimeout(r, ms))
  const after = readProcs({ withDetail: true })
  const elapsedMs = performance.now() - t0
  const cpu1 = cpuTotals()
  const mem = meminfo()
  const total = cpu1.total - cpu0.total
  return {
    before, after, elapsedMs,
    clkTck: getconf('CLK_TCK', 100),
    pageSize: getconf('PAGESIZE', 4096),
    sys: {
      cores: Number(readOr('/proc/cpuinfo', '').match(/^processor\s*:/gm)?.length) || 1,
      load: readOr('/proc/loadavg', '0 0 0').split(' ').slice(0, 3).map(Number),
      uptime: Number(readOr('/proc/uptime', '0').split(' ')[0]),
      cpuPct: total > 0 ? (1 - (cpu1.idle - cpu0.idle) / total) * 100 : 0,
      memPct: mem.MemTotal ? (1 - mem.MemAvailable / mem.MemTotal) * 100 : 0,
      swapPct: mem.SwapTotal ? (1 - mem.SwapFree / mem.SwapTotal) * 100 : null,
      stall: { cpu: pressure('cpu'), memory: pressure('memory'), io: pressure('io') },
    },
    selfPid: process.pid,
    home: homedir(),
  }
}

// ─── naming a process ────────────────────────────────────────────────────────

const isKernel = p => p.pid === 2 || p.ppid === 2
const argsOf = p => (p.args?.length ? p.args : [p.comm])
const isShell = p => SHELLS.has(p.comm)

/** A shell a person types into: no `-c` and no script argument. */
const isInteractiveShell = p => {
  if (!isShell(p)) return false
  const rest = argsOf(p).slice(1)
  if (rest.includes('-c')) return false
  return !rest.some((a, i) => !a.startsWith('-') && !['--init-file', '--rcfile'].includes(rest[i - 1]))
}

const isLauncher = p =>
  p.pid === 1 || p.comm === 'claude' || p.comm === 'systemd' || p.comm === 'sshd' ||
  DESKTOP.has(p.comm) || TERMINALS.has(p.comm) || isInteractiveShell(p)

/** A command line short enough to read: env assignments, long flags and paths dropped. */
export function shortCmd(p) {
  let args = argsOf(p).filter(a => !/^[A-Z_][A-Z0-9_]*=/.test(a))
  if (!args.length) return p.comm
  const base = basename(args[0])
  let out
  if (RUNTIMES.has(base)) {
    let i = 1
    while (i < args.length && args[i].startsWith('-')) i += VALUE_FLAGS.has(args[i]) ? 2 : 1
    const rest = args.slice(i)
    if (!rest.length) out = [base]
    else if (/^(bun|npx|bunx)$/.test(base) && /^(run|test|x|build|install|add|exec)$/.test(rest[0])) out = [base, ...rest]
    else out = [basename(rest[0]), ...rest.slice(1)]
  } else {
    out = [base, ...args.slice(1)]
  }
  return out
    .filter((a, i) => i === 0 || !(a.startsWith('--') && (a.includes('=') || a.length > 24)))
    .map((a, i) => (i > 0 && a.includes('/') && !a.includes(' ') ? basename(a) : a))
    .join(' ')
}

/** A path a person recognises: `~` for home, an agent worktree as `wt:agent-xxxx`. */
export function shortPath(cwd, home = homedir()) {
  if (!cwd) return '?'
  let s = cwd
  if (home && (s === home || s.startsWith(home + '/'))) s = '~' + s.slice(home.length)
  return s.replace(/\/\.claude\/worktrees\/(agent-[0-9a-f]{4})[0-9a-f]*/, '/wt:$1')
}

// ─── jobs ────────────────────────────────────────────────────────────────────

/**
 * The jobs in a sample, hottest first, with the machine numbers.
 * Pure over what `sample()` returns, so a test hands it a made-up process table.
 */
export function buildHitlist({ before, after, elapsedMs, clkTck, pageSize, sys, selfPid, home }) {
  const secs = Math.max(elapsedMs, 1) / 1000
  const children = new Map()
  for (const p of after.values()) {
    if (!children.has(p.ppid)) children.set(p.ppid, [])
    children.get(p.ppid).push(p)
  }

  // A child seen before the window and gone after it was reaped inside it; its
  // whole lifetime lands in the parent's cutime, and only the in-window part is
  // this sample's.
  const goneBefore = new Map()
  for (const b of before.values()) {
    if (after.has(b.pid)) continue
    goneBefore.set(b.ppid, (goneBefore.get(b.ppid) ?? 0) + b.ticks + b.childTicks)
  }
  const cpuOf = new Map()
  const ownOf = new Map() // without reaped children, so the hot worker is named for itself
  for (const p of after.values()) {
    const b = before.get(p.pid)
    const own = p.ticks - (b?.ticks ?? 0)
    const reaped = p.childTicks - (b?.childTicks ?? 0) - (b ? goneBefore.get(p.pid) ?? 0 : 0)
    const pct = t => t / clkTck / secs * 100
    ownOf.set(p.pid, pct(Math.max(own, 0)))
    cpuOf.set(p.pid, pct(Math.max(own, 0) + Math.max(reaped, 0)))
  }

  const rootOf = new Map()
  const findRoot = p => {
    if (rootOf.has(p.pid)) return rootOf.get(p.pid)
    let cur = p
    if (!isLauncher(p)) {
      for (let parent = after.get(cur.ppid); parent && !isLauncher(parent); parent = after.get(cur.ppid)) cur = parent
    }
    rootOf.set(p.pid, cur)
    return cur
  }

  const ancestors = p => {
    const out = []
    for (let a = after.get(p.ppid); a && out.length < 64; a = after.get(a.ppid)) out.push(a)
    return out
  }
  const inEditor = p => ancestors(p).find(a => EDITORS.has(a.comm))
  const startedBy = root => {
    const l = ancestors(root).find(isLauncher)
    if (!l || l.pid === 1) return { kind: 'system', text: 'system', pid: l?.pid ?? null }
    const editor = inEditor(l)
    if (l.comm === 'claude') {
      return { kind: 'claude', pid: l.pid, project: l.cwd ? basename(l.cwd) : null, in: editor ? 'vscode' : 'term',
        text: `claude ${l.cwd ? basename(l.cwd) + ' ' : ''}${l.pid} ${editor ? 'vscode' : 'term'}` }
    }
    if (isShell(l)) {
      const term = editor ? 'vscode' : ancestors(l).find(a => TERMINALS.has(a.comm))?.comm ?? 'term'
      return { kind: 'shell', pid: l.pid, in: term, text: `shell ${l.pid} ${term}` }
    }
    if (DESKTOP.has(l.comm)) return { kind: 'desktop', pid: l.pid, text: 'desktop' }
    if (l.comm === 'systemd') return { kind: 'service', pid: l.pid, text: 'user service' }
    if (l.comm === 'sshd') return { kind: 'ssh', pid: l.pid, text: 'ssh' }
    return { kind: 'terminal', pid: l.pid, text: l.comm }
  }

  const subtreeCpu = new Map()
  const treeCpu = p => {
    if (subtreeCpu.has(p.pid)) return subtreeCpu.get(p.pid)
    const n = cpuOf.get(p.pid) + (children.get(p.pid) ?? []).filter(c => !isLauncher(c)).reduce((a, c) => a + treeCpu(c), 0)
    subtreeCpu.set(p.pid, n)
    return n
  }
  // The command the job is named after: down from the root through shells and
  // wrappers, toward whichever child holds the CPU.
  const named = root => {
    let cur = root
    while ((isShell(cur) || WRAPPERS.has(cur.comm)) && !isLauncher(cur)) {
      const kids = (children.get(cur.pid) ?? []).filter(c => !isLauncher(c))
      if (!kids.length) break
      cur = kids.reduce((a, b) => (treeCpu(b) > treeCpu(a) ? b : a))
    }
    return cur
  }

  const jobs = new Map()
  const kernelHot = []
  for (const p of after.values()) {
    if (p.pid === selfPid) continue
    if (isKernel(p)) {
      const cpu = cpuOf.get(p.pid)
      if (cpu >= 5) kernelHot.push({ comm: p.comm, cpu, reclaim: RECLAIM.test(p.comm) })
      continue
    }
    const root = findRoot(p)
    if (!jobs.has(root.pid)) jobs.set(root.pid, { root, procs: [] })
    jobs.get(root.pid).procs.push(p)
  }

  const out = []
  for (const { root, procs } of jobs.values()) {
    const cpu = procs.reduce((a, p) => a + cpuOf.get(p.pid), 0)
    const head = named(root)
    const hot = procs.reduce((a, b) => (ownOf.get(b.pid) > ownOf.get(a.pid) ? b : a))
    const by = startedBy(root)
    const isApp = by.kind === 'desktop' || by.kind === 'service' || by.kind === 'system'
    let label = shortCmd(head)
    const first = p => shortCmd(p).split(' ')[0].toLowerCase()
    const hotName = shortCmd(hot).split(' ')[0]
    if (!isApp && hotName.toLowerCase() !== label.split(' ')[0].toLowerCase()) {
      const n = procs.filter(p => first(p) === hotName.toLowerCase()).length
      label += ` → ${hotName}${n > 1 ? ` ×${n}` : ''}`
    }
    if (isLauncher(root) && root.comm === 'claude') label = `claude session ${root.pid} itself`

    // Stop the job: one process-group kill when the job IS one group it leads;
    // an app (the desktop or a service started it) is asked to quit at its root;
    // otherwise each group the job leads, and each stray process.
    const pids = new Set(procs.map(p => p.pid))
    let stop
    if (procs.every(p => p.pgid === root.pid)) stop = `kill -TERM -- -${root.pid}`
    else if (root.comm === 'claude' || isInteractiveShell(root)) stop = `kill -TERM ${root.pid}`
    else if (isApp) stop = `kill -TERM ${root.pid}   # quits the whole app — every window and what runs inside it`
    else if (isLauncher(root)) stop = `kill -TERM ${root.pid}`
    else {
      const targets = [...new Set(procs.map(p => (pids.has(p.pgid) ? -p.pgid : p.pid)))]
      stop = targets.length <= 8 ? `kill -TERM -- ${targets.join(' ')}` : `kill -TERM ${root.pid}   # its detached children may outlive it`
    }

    out.push({
      cpu,
      share: cpu / sys.cores,
      rssBytes: procs.reduce((a, p) => a + p.rssPages * pageSize, 0),
      procs: procs.length,
      ageSecs: Math.max(sys.uptime - head.start / clkTck, 0),
      label,
      where: shortPath(head.cwd ?? root.cwd, home),
      cwd: head.cwd ?? root.cwd ?? null,
      startedBy: by,
      rootPid: root.pid,
      stop,
    })
  }
  out.sort((a, b) => b.cpu - a.cpu)
  return { sys, kernelHot: kernelHot.sort((a, b) => b.cpu - a.cpu), jobs: out }
}

// ─── the screen ──────────────────────────────────────────────────────────────

const fmtBytes = n => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)}G` : `${Math.round(n / 1024 ** 2)}M`)
const fmtAge = s => (s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}` : s < 86400 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}` : `${Math.floor(s / 86400)}d`)
const clipEnd = (s, n) => (s.length <= n ? s.padEnd(n) : s.slice(0, Math.max(n - 1, 0)) + '…')
const clipMid = (s, n) => (s.length <= n ? s.padEnd(n) : n < 8 ? s.slice(-n) : '…' + s.slice(-(n - 1)))

/** The hitlist as lines for a terminal `width` wide; `c` is chalk (or identity functions). */
export function renderHitlist({ sys, kernelHot, jobs }, { width = 120, c, top = 10, minCpu = 3 } = {}) {
  const lines = []
  const bad = (cond, s) => (cond ? c.red(s) : s)
  const warn = (cond, s) => (cond ? c.yellow(s) : s)

  const ratio = sys.load[0] / sys.cores
  const head = [
    bad(ratio > 1, warn(ratio > 0.7, `load ${sys.load[0].toFixed(1)} on ${sys.cores} cores`)),
    bad(sys.cpuPct > 90, `cpu ${Math.round(sys.cpuPct)}%`),
    bad(sys.memPct > 90, `mem ${Math.round(sys.memPct)}%`),
  ]
  if (sys.swapPct != null) head.push(bad(sys.swapPct > 90, `swap ${Math.round(sys.swapPct)}%${sys.swapPct > 90 ? ' FULL' : ''}`))
  const stalls = Object.entries(sys.stall).filter(([, v]) => v != null && v >= 5).map(([k, v]) => `${k} ${Math.round(v)}%`)
  if (stalls.length) head.push(c.yellow(`stalled: ${stalls.join(' ')}`))
  lines.push(head.join(c.dim(' · ')))

  const reclaim = kernelHot.filter(k => k.reclaim)
  if (reclaim.length) lines.push(c.yellow(`kernel is reclaiming memory: ${reclaim.map(k => `${k.comm} ${Math.round(k.cpu)}%`).join(', ')}`))
  const otherKernel = kernelHot.filter(k => !k.reclaim)
  if (otherKernel.length) lines.push(c.dim(`kernel threads: ${otherKernel.slice(0, 4).map(k => `${k.comm} ${Math.round(k.cpu)}%`).join(', ')}`))

  const hot = jobs.filter(j => j.cpu >= minCpu).slice(0, top)
  lines.push('')
  if (!hot.length) {
    lines.push(c.green(`nothing is busy — no job above ${minCpu}% of a core`))
  } else {
    const fixed = 3 + 6 + 7 + 6 + 6 + 2
    const byW = Math.min(32, Math.max(14, Math.floor((width - fixed) * 0.3)))
    const rest = Math.max(width - fixed - byW - 2, 30)
    const jobW = Math.ceil(rest * 0.55)
    const whereW = rest - jobW - 1
    lines.push(c.dim(`${'#'.padEnd(3)}${'CPU'.padStart(5)} ${'RSS'.padStart(6)} ${'PROCS'.padStart(5)} ${'AGE'.padStart(5)}  ${clipEnd('STARTED BY', byW)}  ${clipEnd('JOB', jobW)} WHERE`))
    hot.forEach((j, i) => {
      const cpu = `${Math.round(j.cpu)}%`.padStart(5)
      lines.push(
        `${c.bold(String(i + 1).padEnd(3))}${bad(j.cpu >= 100, warn(j.cpu >= 30, cpu))} ${fmtBytes(j.rssBytes).padStart(6)} ${String(j.procs).padStart(5)} ${fmtAge(j.ageSecs).padStart(5)}  ` +
        `${(j.startedBy.kind === 'claude' ? c.cyan : s => s)(clipEnd(j.startedBy.text, byW))}  ${c.bold(clipEnd(j.label, jobW))} ${c.dim(clipMid(j.where, whereW).trimEnd())}`,
      )
    })

    const bg = jobs.filter(j => j.cpu >= 0.5 && !hot.includes(j)).slice(0, 6)
    if (bg.length) lines.push(c.dim(`── also ── ${bg.map(j => `${j.label.split(' ')[0]} ${Math.round(j.cpu)}%`).join(' · ')}`))

    lines.push('')
    const share = hot.reduce((a, j) => a + j.share, 0)
    const notes = []
    if (hot[0].share >= 30) notes.push(`#1 alone is ${Math.round(hot[0].share)}% of the machine`)
    else notes.push(`these ${hot.length} jobs hold ${Math.round(share)}% of the machine`)
    const sessions = new Set(hot.filter(j => j.startedBy.kind === 'claude').map(j => j.startedBy.pid))
    const fromClaude = hot.filter(j => j.startedBy.kind === 'claude').length
    if (fromClaude) notes.push(`${fromClaude} started by ${sessions.size} Claude session${sessions.size > 1 ? 's' : ''}`)
    if (sys.swapPct != null && sys.swapPct > 90) notes.push('swap is full, so memory is part of it')
    lines.push(notes.join(' · '))
    hot.slice(0, 3).forEach((j, i) => lines.push(c.dim(`stop #${i + 1}: `) + j.stop))
  }
  return lines
}
