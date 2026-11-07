// src/domain/atlas/autopilot-run.ts — a schedule entry's loop, started by hand
// from the Switch.
//
// Run now spawns the entry's script with the flags its caps map to (`flagsOf`
// in `@frontierjs/cli/core/autopilot.js`, `--source autopilot` last) the way
// the workbench's Run tab spawns `fli dev`: detached and unref'd, so a restart
// of this API (`bun --watch` over a tree a chat edits) leaves the loop running,
// with what it prints in a file of its own under ~/.fli/autopilot/. There is
// no second log: the run shows in its lane off the loop's own log lines, which
// carry `source`, and the loop holds the day's cap itself. What this module
// holds is which entry is running now, in memory — the lane locks are the fix
// loop's own record and a frame run has none — so a Run now on an entry still
// running is refused, and one started before a restart is not known here and
// is refused by the lane lock instead.
//
// A loop with no script (`post`) runs in this process through a callback the
// caller hands in, and its Running has no pid: the callback's promise is the
// thing still going, so it is forgotten when that settles.

import { spawn }                                                                   from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { stateDir }                                                                from '@frontierjs/cli/core/paths.js'
import { join }                                                                    from 'node:path'
import { parseCron, cronMatches }                                                  from '@frontierjs/toolbelt/cron'

export type Entry   = { loop: string, cron: string, caps: Record<string, unknown>, flags: string[], worst: number | null }
/** `pid` and `log` are null for a loop that runs inside this API. */
export type Running = { loop: string, pid: number | null, at: string, log: string | null }
export type Tick    = { at: string, since: string, started: Array<{ entry: number, loop: string, pid: number | null }>, skipped: Array<{ entry: number, loop: string, why: string }> }
type Loops = Record<string, { script: string | null }>
/** Runs a script-less entry's loop in this process; a rejection is the caller's to log, since nothing awaits the run. */
export type InProcess = (entry: Entry) => Promise<unknown>

const running = new Map<number, Running>()

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch (err) { return (err as { code?: string }).code === 'EPERM' } }

export const OUT_DIR = () => join(stateDir(), 'autopilot')

/** The entry's run while its pid is alive, else null. */
export function runningOf(i: number): Running | null {
  const r = running.get(i)
  if (!r) return null
  if (r.pid === null || alive(r.pid)) return r
  running.delete(i)
  return null
}

/** Start entry `i` (0-based) of the schedule at `root`, the loops' scripts being `loops`. */
export function startEntry(root: string, loops: Loops, entries: Entry[], i: number, env: NodeJS.ProcessEnv, { outDir = OUT_DIR(), inProcess }: { outDir?: string, inProcess?: InProcess } = {}): { started: Running } | { refused: string } {
  const entry = entries[i]
  if (!entry) return { refused: `the schedule has no entry ${i + 1}; it lists ${entries.length}` }
  const had = runningOf(i)
  if (had) return { refused: `entry ${i + 1} (${entry.loop}) is already running${had.pid === null ? '' : ` (pid ${had.pid})`} since ${had.at}` }
  if (loops[entry.loop] && loops[entry.loop].script === null) {
    if (!inProcess) return { refused: `${entry.loop} runs inside this API and was handed no way to run it` }
    const run: Running = { loop: entry.loop, pid: null, at: new Date().toISOString(), log: null }
    running.set(i, run)
    const forget = () => { if (running.get(i) === run) running.delete(i) }
    inProcess(entry).then(forget, (err) => { forget(); console.error(`[autopilot] entry ${i + 1} (${entry.loop}) failed: ${(err as Error).message}`) })
    return { started: run }
  }
  const rel    = loops[entry.loop]?.script
  const script = rel ? join(root, rel) : null
  if (!script || !existsSync(script)) return { refused: `${rel ?? entry.loop} is not beside the registers at ${root}: the loops run from a checkout of frontierjs (FJS-D1776)` }

  mkdirSync(outDir, { recursive: true })
  const at  = new Date().toISOString()
  const log = join(outDir, `${entry.loop}-${i + 1}.log`)
  writeFileSync(log, `$ bun ${rel} ${entry.flags.join(' ')}   (${at})\n`)
  const fd = openSync(log, 'a')
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(process.execPath, [script, ...entry.flags], { cwd: root, detached: true, env: { ...env, NO_COLOR: '1' }, stdio: ['ignore', fd, fd] })
  } finally { closeSync(fd) }
  child.unref()
  const run: Running = { loop: entry.loop, pid: child.pid ?? 0, at, log }
  // Only its own record: a later start of the same entry has replaced it.
  const forget = () => { if (running.get(i)?.pid === run.pid) running.delete(i) }
  child.on('error', forget)
  child.on('exit', forget)
  running.set(i, run)
  return { started: run }
}

// ─── The tick ────────────────────────────────────────────────────────────────
//
// `jobs/autopilot-tick.job.ts` runs every five minutes, and an entry is due
// when its cron line names a wall-clock minute inside the window since the
// last tick. The window is persisted (`tick.json` beside the run logs), so a
// restart of the API neither replays a night of fires nor drops the one that
// fell while it was down; a window longer than a day is cut to the last five
// minutes, because a laptop that slept a week asked for none of them.

const TICK_FILE = (outDir: string) => join(outDir, 'tick.json')
const MAX_WINDOW_MS = 24 * 60 * 60_000
export const TICK_MS = 5 * 60_000

const partsOf = (d: Date) => ({ minutes: d.getMinutes(), hours: d.getHours(), date: d.getDate(), month: d.getMonth() + 1, day: d.getDay() })

/** Whether `cron` names a local minute after `since` and up to `now`. The same
 *  minute walk as caravan's `CronScheduler._tickFixed`, on the host clock and
 *  without its zone handling: an entry's line is written in this machine's day. */
export function dueAt(cron: string, since: Date, now: Date): boolean {
  const fields = parseCron(cron)
  const first  = new Date(since)
  first.setSeconds(0, 0)
  first.setMinutes(first.getMinutes() + 1)
  for (const t = first; t <= now; t.setMinutes(t.getMinutes() + 1)) if (cronMatches(fields, partsOf(t))) return true
  return false
}

export function readTick(outDir = OUT_DIR()): Tick | null {
  try { return JSON.parse(readFileSync(TICK_FILE(outDir), 'utf8')) as Tick } catch { return null }
}

/** The window's start: the last tick, or five minutes ago when there was none or it is over a day old. */
export function tickSince(last: Tick | null, now: Date): Date {
  const at = last ? new Date(last.at).getTime() : NaN
  return new Date(Number.isFinite(at) && now.getTime() - at <= MAX_WINDOW_MS ? at : now.getTime() - TICK_MS)
}

type TickInput = {
  root: string, loops: Loops, entries: Entry[], env: NodeJS.ProcessEnv
  cap: string | null, freeLanes: number, since: Date, now: Date
  start?: typeof startEntry, outDir?: string, inProcess?: InProcess
}

/**
 * One pass over the schedule: start each entry that is due, refusing the pass
 * when the day's cap is spent and an entry whose lanes are held. What was
 * started and why the rest were not is the tick's record, written beside the
 * run logs so the Switch and the next tick read it.
 */
export function tick({ root, loops, entries, env, cap, freeLanes, since, now, start = startEntry, outDir = OUT_DIR(), inProcess }: TickInput): Tick {
  const out: Tick = { at: now.toISOString(), since: since.toISOString(), started: [], skipped: [] }
  entries.forEach((e, i) => {
    const entry = i + 1
    if (!dueAt(e.cron, since, now)) return
    if (cap) { out.skipped.push({ entry, loop: e.loop, why: cap }); return }
    const lanes = typeof e.caps.lanes === 'number' ? e.caps.lanes : 0
    if (lanes > freeLanes) { out.skipped.push({ entry, loop: e.loop, why: `${lanes} lanes asked, ${freeLanes} free` }); return }
    const r = start(root, loops, entries, i, env, { outDir, inProcess })
    if ('refused' in r) out.skipped.push({ entry, loop: e.loop, why: r.refused })
    else { out.started.push({ entry, loop: e.loop, pid: r.started.pid }); freeLanes -= lanes }
  })
  mkdirSync(outDir, { recursive: true })
  writeFileSync(TICK_FILE(outDir), JSON.stringify(out, null, 2) + '\n')
  return out
}
