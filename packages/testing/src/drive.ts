// @frontierjs/testing/drive — one run of an app in a real browser, so an app's
// verify file is its steps and nothing else.
//
//   await drive({
//     servers: [
//       { name: 'api', cmd: ['bun', 'run', 'api'], url: `${API}/health` },
//       { name: 'web', cmd: ['bun', 'run', 'web'], url: UI },
//     ],
//     open: UI,
//   }, async (page, check) => {
//     await page.fill('input[name=email]', 'dev@example.com')
//     await page.clickAt('button[type=submit]')
//     await page.waitFor(`location.pathname === '/home'`)
//     check.clean('sign in')
//   })
//
// The page is `@frontierjs/mesa/drive`'s handle (FJS-D554); this owns what goes
// around it: the servers, the checks and the exit code.
//
// ── Why a port that answers is refused ───────────────────────────────────────
//
// A dev server serves the code it started with, and a port that answers is not
// evidence the right process holds it (FJS-740). Adopting one grades another
// checkout's build, or yesterday's. Every server named here is started by this
// run and killed by it, so a busy port fails the run before anything starts.
//
// ── Why every server is its own process group ────────────────────────────────
//
// `bun run web` is a launcher: its child is the server. Killing the pid kills
// the wrapper and leaves the server holding the port for the next run, so a
// server is spawned detached and killed as a group, on a throw, on a signal and
// on exit.

import { spawn, type ChildProcess } from 'node:child_process'
import { connect }                  from 'node:net'
import { openChrome, type Chrome, type ChromeOptions } from '@frontierjs/mesa/drive'

export interface Server {
  name: string
  cmd:  string[]
  /** Polled until it answers below 500. Its port is the one refused if taken. */
  url:  string
  cwd?: string
  env?: Record<string, string>
  /** How long it may take to answer. Default 30s. */
  ms?:  number
}

export interface DriveOptions extends ChromeOptions {
  servers?: Server[]
  /** Navigated to before the steps run. */
  open?:    string
  /** An expression the page sets once its own boot has finished. */
  ready?:   string
}

export interface Check {
  /** `want` omitted checks that `got` is truthy; given, that the two are deeply equal. */
  (label: string, got: unknown, want?: unknown): boolean
  /** A page error or failed response this run provokes, matched by pattern. */
  allow(pattern: RegExp): void
  /** Fail `step` if the page threw or a response failed since the last clean, then forget them. */
  clean(step: string): boolean
}

export interface DriveResult {
  passed: number
  failed: string[]
}

export type Steps = (page: Chrome, check: Check) => Promise<void>

const TAIL = 40

// ─── servers ─────────────────────────────────────────────────────────────────

interface Running { server: Server, child: ChildProcess, tail: string[], exited: number | null }

function portOf(url: string) {
  const u = new URL(url)
  return { host: u.hostname, port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)) }
}

function answers(host: string, port: number) {
  return new Promise<boolean>((resolve) => {
    const sock = connect({ host, port })
    const done = (up: boolean) => { sock.destroy(); resolve(up) }
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
    sock.setTimeout(500, () => done(false))
  })
}

// `localhost` resolves to ::1 on some hosts and 127.0.0.1 on others, and a
// server bound to one is refused on the other, so asking one reads a held port
// as free.
async function taken(url: string) {
  const { host, port } = portOf(url)
  const hosts = host === 'localhost' ? ['127.0.0.1', '::1'] : [host]
  for (const h of hosts) if (await answers(h, port)) return port
  return null
}

function start(server: Server): Running {
  const [bin, ...args] = server.cmd
  const child = spawn(bin, args, {
    cwd:      server.cwd,
    env:      { ...process.env, ...server.env },
    detached: true,
    stdio:    ['ignore', 'pipe', 'pipe'],
  })
  const run: Running = { server, child, tail: [], exited: null }
  const keep = (d: Buffer) => {
    run.tail.push(...d.toString().split('\n').filter(Boolean))
    run.tail.splice(0, Math.max(0, run.tail.length - TAIL))
  }
  child.stdout!.on('data', keep)
  child.stderr!.on('data', keep)
  child.once('error', (e) => { run.tail.push(`spawn failed: ${e.message}`); run.exited = -1 })
  child.once('exit', (code, signal) => { run.exited = code ?? (signal ? 128 : -1) })
  return run
}

async function ready(run: Running) {
  const { name, url, ms = 30_000 } = run.server
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (run.exited !== null) break
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).status < 500) return
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  const why = run.exited !== null ? `exited (${run.exited})` : `did not answer in ${ms}ms`
  throw new Error(`${name} ${why} before ${url} answered${run.tail.length ? `:\n  ${run.tail.join('\n  ')}` : ''}`)
}

function killGroup(run: Running, signal: NodeJS.Signals) {
  if (run.exited !== null || !run.child.pid) return
  try { process.kill(-run.child.pid, signal) } catch { /* already gone */ }
}

async function stop(runs: Running[]) {
  for (const r of runs) killGroup(r, 'SIGTERM')
  const until = Date.now() + 3000
  while (Date.now() < until && runs.some((r) => r.exited === null))
    await new Promise((r) => setTimeout(r, 50))
  for (const r of runs) killGroup(r, 'SIGKILL')
}

// ─── checks ──────────────────────────────────────────────────────────────────

function checker(page: () => Chrome | null, result: DriveResult): Check {
  const allowed: RegExp[] = []

  const record = (label: string, ok: boolean, detail = '') => {
    if (ok) result.passed++
    else result.failed.push(label)
    console.log(`${ok ? '✓' : '✗'} ${label}${!ok && detail ? ` — ${detail}` : ''}`)
    return ok
  }

  const check = ((label: string, got: unknown, ...want: unknown[]) => want.length
    ? record(label, Bun.deepEquals(got, want[0]), `got ${JSON.stringify(got)}, want ${JSON.stringify(want[0])}`)
    : record(label, !!got, `got ${JSON.stringify(got)}`)) as Check

  check.allow = (pattern) => { allowed.push(pattern) }

  check.clean = (step) => {
    const p = page()
    if (!p) return true
    const seen = [...p.errors.splice(0), ...p.failed.splice(0)]
      .filter((line) => !allowed.some((re) => re.test(line)))
    return record(`${step}: no page errors or failed responses`, seen.length === 0, seen.join('; '))
  }

  return check
}

// ─── the run ─────────────────────────────────────────────────────────────────

/** Refuse a taken port, start the servers, open the page, run the steps, and
 *  stop everything whatever happened. `process.exitCode` is set from the result. */
export async function drive(options: DriveOptions, steps: Steps): Promise<DriveResult> {
  const { servers = [], open, ready: booted, ...chrome } = options
  const result: DriveResult = { passed: 0, failed: [] }
  const runs: Running[] = []
  let page: Chrome | null = null
  const check = checker(() => page, result)

  // Synchronous: an exit handler cannot await. A signal ends the run here, and
  // mesa's own handler sees this listener and leaves the exit to it.
  const sweep = () => { for (const r of runs) killGroup(r, 'SIGKILL') }
  const onSignal = (sig: NodeJS.Signals) => { sweep(); process.exit(sig === 'SIGINT' ? 130 : 143) }
  process.on('exit', sweep)
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  try {
    const held = (await Promise.all(servers.map(async (s) => [s, await taken(s.url)] as const)))
      .filter(([, port]) => port !== null)
    if (held.length)
      throw new Error(held.map(([s, port]) =>
        `${s.name}: port ${port} already answers — stop what holds it; a running server serves the code it started with`).join('\n'))

    for (const s of servers) runs.push(start(s))
    await Promise.all(runs.map(ready))

    page = await openChrome(chrome)
    if (open) await page.navigate(open, booted)
    await steps(page, check)
    check.clean('after the last step')
  } catch (e) {
    result.failed.push(e instanceof Error ? e.message : String(e))
    console.log(`✗ ${e instanceof Error ? e.message : e}`)
  } finally {
    await page?.close()
    await stop(runs)
    process.off('exit', sweep)
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }

  console.log(`\n${result.passed} passed, ${result.failed.length} failed`)
  process.exitCode = result.failed.length ? 1 : 0
  return result
}
