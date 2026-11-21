---
title: utils:top
description: A vtop look-alike — CPU and memory graphs, processes grouped by name, dd to kill
alias: top
examples:
  - fli top
  - fli top --interval 1000
  - fli top --once
  - fli top --hitlist
  - fli top --record
  - fli top --record --install
  - fli top --at 12:50
  - fli top --at=-15m --json
  - fli top --history --since=-2h
flags:
  hitlist:
    char: H
    type: boolean
    description: one screen of what is maxing the machine — jobs (not process names), where each runs, who started it, how to stop it
    defaultValue: false
  json:
    type: boolean
    description: with --hitlist or --at, print the data as JSON for a script or an agent
    defaultValue: false
  record:
    type: boolean
    description: record a sample every 10 s to the history files, in the foreground (see --install to run it as a service)
    defaultValue: false
  install:
    type: boolean
    description: with --record, write the systemd user unit that runs the recorder and print the command that starts it
    defaultValue: false
  at:
    type: string
    description: print the recorded sample nearest a time (HH:MM, HH:MM:SS, an ISO date, or -15m, which a flag takes as `--at=-15m` or `--at 15m`) in the hitlist layout, with any oomd kills within 2 min
    defaultValue: ''
  history:
    type: boolean
    description: one line per minute from the recording — memory pressure, fork rate, memory, swap, the heaviest group and job, oomd kills
    defaultValue: false
  since:
    type: string
    description: with --history, the start (default -60m)
    defaultValue: ''
  until:
    type: string
    description: with --history, the end (default now)
    defaultValue: ''
  every:
    type: number
    description: with --record, seconds between samples
    defaultValue: 10
  bin:
    type: string
    description: with --record --install, the fli entry the unit runs (default the global fli, resolved to its checkout)
    defaultValue: ''
  once:
    type: boolean
    description: print the process table once and exit, for a script or an ssh session
    defaultValue: false
  interval:
    char: i
    type: number
    description: milliseconds between redraws
    defaultValue: 300
---

<script>
import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { dlopen, FFIType, ptr } from 'bun:ffi'

const source = () => resolve(global.fliRoot, 'native/top')
const cacheDir = () => join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'frontierjs/top')
const has = tool => spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0

// Cargo when the machine has it; cc otherwise, since a C compiler is on nearly
// every Linux box and the two sources draw the same screen. Each returns the
// binary, or cargo's or cc's own output so a broken toolchain explains itself.
const buildRust = () => {
  const r = spawnSync('cargo', ['build', '--release', '--quiet',
    '--manifest-path', join(source(), 'Cargo.toml'), '--target-dir', cacheDir()], { encoding: 'utf8' })
  return r.status === 0 ? { bin: join(cacheDir(), 'release/fli-top') } : { error: r.stderr || r.stdout }
}

// cargo fingerprints its own sources; cc does not, so an edit to top.c rebuilds by mtime
const buildC = () => {
  const src = join(source(), 'top.c')
  const bin = join(cacheDir(), 'fli-top-c')
  if (existsSync(bin) && statSync(bin).mtimeMs >= statSync(src).mtimeMs) return { bin }
  mkdirSync(cacheDir(), { recursive: true })
  const r = spawnSync('cc', ['-O2', '-o', bin, src], { encoding: 'utf8' })
  return r.status === 0 ? { bin } : { error: r.stderr || r.stdout }
}

// Replace this process rather than spawn a child: Bun idles at ~27 MB, the
// monitor at ~2 MB, and a parent left waiting would hold both for the session.
const execv = argv => {
  const libc = dlopen('libc.so.6', { execv: { args: [FFIType.cstring, FFIType.ptr], returns: FFIType.i32 } })
  const bufs = argv.map(s => Buffer.from(s + '\0'))
  const list = new BigUint64Array(bufs.length + 1)
  bufs.forEach((b, i) => { list[i] = BigInt(ptr(b)) })
  libc.symbols.execv(ptr(bufs[0]), ptr(list))
}
</script>

The monitor is native code built on first use from `native/top/` — Rust with
cargo, else C with cc — into `~/.cache/frontierjs/top`, then fli hands the
terminal to it. Keys: `j`/`k` move, `g`/`G` jump, `c`/`m` sort by CPU or
memory, `/` filters groups by name (Enter keeps it, Esc clears it), Enter
opens a group to its processes and command lines, `dd` sends SIGTERM to the
selected group or process, `D` sends SIGKILL after a `y`, `q` quits. The Ports
column lists listening TCP ports, refreshed every ~10 s; another user's
process shows none unless fli top runs as root.

`--once` prints the table with CPU over one second and exits, and needs no
terminal.

`--hitlist` answers "what is maxing the CPU?" in one screen. It samples for a
second and groups every process into the JOB a launcher started — a Claude
session, an interactive shell, the desktop, a service — so twenty `tsc` workers
under one `bun run --filter * typecheck` are one row, not `node 540%`. Each row
says where the job runs (an agent worktree reads `wt:agent-xxxx`), who started
it, and its age; the head line says whether memory is part of it (swap,
pressure stalls, the kernel reclaiming). It prints a `kill` for the top three
and kills nothing. Plain JS in `core/hitlist.js`, so it needs no build.

```js
if (process.platform !== 'linux') {
  log.error('fli top reads /proc, so it runs on Linux only')
  process.exitCode = 1; return
}
if (flag.record || flag.at || flag.history) {
  const th = await import(resolve(global.fliRoot, 'core/top-history.js'))
  const { chalk } = await import(resolve(global.fliRoot, 'core/color.js'))
  const width = process.stdout.columns || Number(process.env.COLUMNS) || 120
  const dir = th.historyDir()
  try {
    if (flag.record && flag.install) {
      const { bin, warn } = th.resolveFliBin({ bin: flag.bin || null, here: resolve(global.fliRoot, 'bin/fli.js') })
      if (warn) log.warn(warn)
      const { file, enable } = th.installUnit({ fliBin: bin, everySecs: flag.every !== 10 ? flag.every : null })
      console.log(`wrote ${file}\n  runs: ${process.execPath} ${bin} top --record\nstart it with:\n  ${enable}`)
    } else if (flag.record) {
      const every = Math.max(Number(flag.every) || 10, 1)
      console.log(`recording every ${every}s to ${dir} (Ctrl-C stops)`)
      const stop = () => { const cpu = th.selfCpuSecs(); console.log(`\nstopped: ${cpu.toFixed(2)}s CPU (children included) over ${Math.round(performance.now() / 1000)}s`); process.exit(0) }
      process.on('SIGINT', stop); process.on('SIGTERM', stop)
      await th.recordLoop({
        dir, everyMs: every * 1000,
        onPrune: gone => console.log(`pruned ${gone.join(', ')}`),
        onSample: rec => {
          if (process.stdout.isTTY) console.log(`${th.localTime(rec.ts).slice(11)} mem psi ${rec.psi.mem[0] ?? '-'}% forks ${rec.forks ?? '-'}/min ${rec.jobs.length} jobs ${rec.groups?.length ?? 0} groups cost ${rec.self.cpuMs}ms`)
        },
      })
    } else if (flag.at) {
      const ms = th.parseTime(flag.at)
      const found = th.lookupAt(dir, ms)
      if (!found) { log.error(`no recorded sample within 15 min of ${th.localTime(ms)} in ${dir} — start \`fli top --record\``); process.exitCode = 1; return }
      if (flag.json) console.log(JSON.stringify(found.sample, null, 2))
      else console.log(th.renderAt(found, { c: chalk, width }).join('\n'))
    } else {
      const now = Date.now()
      const from = th.parseTime(flag.since || '-60m', now)
      const to = flag.until ? th.parseTime(flag.until, now) : now
      const rows = th.aggregateHistory(th.loadSamples(dir, from, to), { from, to })
      if (flag.json) console.log(JSON.stringify(rows, null, 2))
      else console.log(th.renderHistory(rows, { c: chalk, width, from, to }).join('\n'))
    }
  } catch (e) {
    log.error(e.message)
    process.exitCode = 1
  }
  return
}
if (flag.hitlist) {
  const { sample, buildHitlist, renderHitlist } = await import(resolve(global.fliRoot, 'core/hitlist.js'))
  const { chalk } = await import(resolve(global.fliRoot, 'core/color.js'))
  const list = buildHitlist(await sample(1000))
  if (flag.json) console.log(JSON.stringify(list, null, 2))
  else console.log(renderHitlist(list, { width: process.stdout.columns || Number(process.env.COLUMNS) || 120, c: chalk }).join('\n'))
  return
}
if (!flag.once && (!process.stdin.isTTY || !process.stdout.isTTY)) {
  log.error('fli top needs a terminal')
  process.exitCode = 1; return
}

const built = has('cargo') ? buildRust() : has('cc') ? buildC() : null
if (!built) {
  log.error('fli top builds on first use and needs cargo (https://rustup.rs) or a C compiler (cc)')
  process.exitCode = 1; return
}
if (built.error) {
  log.error(`fli top did not build:\n${built.error.trim()}`)
  process.exitCode = 1; return
}

execv([built.bin, '--interval', String(flag.interval), ...(flag.once ? ['--once'] : [])])
log.error(`could not start ${built.bin}`)
process.exitCode = 1
```
