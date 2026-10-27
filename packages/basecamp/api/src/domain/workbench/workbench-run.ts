// src/domain/workbench/workbench-run.ts — what a pinned checkout can START, and reading one back.
//
// The Run tab of a workbench card: `fli dev` for each app in the checkout, and
// the package.json scripts of the checkout and its apps. The inventory is fli's
// (`findApps` and `tasks` in `@frontierjs/cli/core/runnables.js`), so a row here
// and a row in `fli gui` are one row. A request names a row ID and never a
// command; the argv comes from the inventory, which comes from the tree.
//
// Not `runnables()` itself: its snapshot walk reads every file under the tree,
// and an app keeping a production copy in `db/` costs seconds a click.
//
// Not `children.js`'s process table either. That one holds its children in
// memory and pipes their output, and the API is `bun --watch` over a tree a
// chat is editing: a restart would leave the dev server up with nothing left
// that can stop it. A run is a record on the pin (`pins.json`) and a log file
// of its own — the shape `claude -p` runs already have — and whether it is up
// is its pid, alive (`domain/workbench/workbench.ts` owns both).

import { existsSync, openSync, readFileSync, readSync, closeSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

export type Runnable = {
  id:     string
  kind:   'app' | 'script'
  name:   string
  /** Where it runs, relative to the checkout; `.` is the checkout itself. */
  dir:    string
  /** What a person would type there. */
  start:  string
  argv:   string[]
  /** A script's body, for the title of its row. */
  script: string | null
}

export type RunRecord = {
  name:    string
  dir:     string
  start:   string
  pid:     number | null
  at:      string
  exit:    { code: number | null, signal: string | null } | null
  stopped: boolean
}

export type Served = { label: string, port: number }

type Cli = {
  findApps: (root: string) => string[]
  tasks:    (root: string) => Array<{ id: string, name: string, dir: string, start: string, argv: string[], run?: string }>
}
type Ports = {
  appPorts:         (appRoot: string, o?: { name?: string, scripts?: Record<string, string> }) => Array<{ category: string, label: string }>
  getSessionStatus: (o?: { lockFile?: string }) => Array<{ root: string, alive: boolean, ports?: Record<string, number | number[]> }>
}

// The cli is a devDependency and the image installs none, so it is reached
// only on a machine where the workbench is offered at all.
let cli: Promise<Cli> | null = null
const loadCli = () => cli ??= import('@frontierjs/cli/core/runnables.js') as unknown as Promise<Cli>
let ports: Promise<Ports> | null = null
const loadPorts = () => ports ??= import('@frontierjs/cli/core/ports.js') as unknown as Promise<Ports>

/** How much of a run's log the tab shows: enough to read why a server died. */
const TAIL_BYTES = 24_000
const TAIL_LINES = 120

function readJson(path: string): Record<string, any> | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

/** Every app in the checkout with `fli dev`, then every script. */
export async function inventory(root: string, name: string): Promise<Runnable[]> {
  const { findApps, tasks } = await loadCli()
  const apps: Runnable[] = findApps(root).map(dir => {
    const rel = relative(root, dir) || '.'
    return {
      id: `app:${rel}`, kind: 'app', dir: rel, start: 'fli dev', argv: ['fli', 'dev'], script: null,
      name: rel === '.' ? name : (readJson(join(dir, 'package.json'))?.name ?? rel),
    }
  })
  const scripts: Runnable[] = tasks(root).map(t => ({
    id: t.id, kind: 'script', name: t.name, dir: t.dir, start: t.start, argv: t.argv, script: t.run ?? null,
  }))
  return [...apps, ...scripts]
}

/**
 * The checkout's OWN fli, never one on PATH: a global install of another
 * vintage driving this tree is the drift the pin in an app removes. An app's
 * `node_modules` from where it runs up to the checkout, then the workspace's
 * `packages/cli`.
 */
export function fliBin(root: string, dir: string): string | null {
  const top = resolve(root)
  for (let at = resolve(root, dir); ; at = dirname(at)) {
    const bin = join(at, 'node_modules', '@frontierjs', 'cli', 'bin', 'fli.js')
    if (existsSync(bin)) return bin
    if (at === top || at === dirname(at)) break
  }
  const own = join(top, 'packages', 'cli', 'bin', 'fli.js')
  return existsSync(own) ? own : null
}

/** The argv a row runs as — `bun` is the API's own, `fli` the checkout's. */
export function resolveArgv(root: string, row: Pick<Runnable, 'argv' | 'dir' | 'name'>): string[] | { refused: string } {
  const [cmd, ...rest] = row.argv
  if (cmd === 'bun') return [process.execPath, ...rest]
  if (cmd === 'fli') {
    const bin = fliBin(root, row.dir)
    if (!bin) return { refused: `${row.name} has no @frontierjs/cli installed — run bun install there` }
    return [process.execPath, bin, ...rest]
  }
  return { refused: `${row.name} starts with ${cmd}, which the workbench does not run` }
}

// A dev server colors its banner whatever NO_COLOR says, and this tab prints
// text, where an escape is a box and `[33m`.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are what this pattern removes
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g

/** The end of a run's log, as lines a page can draw. */
export function tail(file: string): string[] {
  let size = 0
  try { size = statSync(file).size } catch { return [] }
  const from = Math.max(0, size - TAIL_BYTES)
  const buf  = Buffer.alloc(size - from)
  const fd   = openSync(file, 'r')
  try { readSync(fd, buf, 0, buf.length, from) } finally { closeSync(fd) }
  const lines = buf.toString('utf8').replace(ANSI, '').split(/\r?\n|\r/)
  // A cut mid-line leaves half a line first; it says nothing.
  if (from > 0) lines.shift()
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  return lines.slice(-TAIL_LINES)
}

/**
 * The ports a running `fli dev` holds for an app, named — read off the
 * session lock it writes, so a branch's +N×10000 and a slot are what it
 * really bound rather than a derivation that would have to agree with it.
 */
export async function servedBy(appDir: string, lockFile?: string): Promise<Served[]> {
  const { appPorts, getSessionStatus } = await loadPorts()
  const session = getSessionStatus({ lockFile }).find(s => s.root === appDir && s.alive)
  if (!session?.ports) return []
  const pkg    = readJson(join(appDir, 'package.json'))
  const labels = new Map(appPorts(appDir, { name: pkg?.name, scripts: pkg?.scripts }).map(r => [r.category, r.label]))
  const out: Served[] = []
  for (const [category, held] of Object.entries(session.ports))
    for (const port of [held].flat()) if (typeof port === 'number') out.push({ label: labels.get(category) ?? category, port })
  return out
}
