// ─── children.js — the processes the GUI started ─────────────────────────────
//
// The page can start a row and stop what it started, and nothing more than
// that. It is not a process supervisor and the refusal is the design: a row
// that is answering and is not in this table gets no stop button and is told
// why. A page that offered one would be a button that kills something somebody
// else is using, and the failure would be silent to whoever started it.
//
// ── What may be spawned ─────────────────────────────────────────────────────
//
// The caller sends an ID and never a command. The command comes from the
// inventory, which comes from a file in the tree — so a request cannot name
// what runs, only which of the project's own declared commands to run. That is
// the same rule `snapshots.js` applies to a generator, for the same reason, and
// it is why every row carries `argv` rather than a string to be re-split.
//
// Two binaries, both resolved rather than trusted to PATH: `bun`, and `fli`,
// which is rewritten to this package's own `bin/fli.js`. A globally installed
// fli of a different vintage driving this tree is the drift a pin removes.
// Everything else is refused BY NAME with the command to type, which is the
// honest answer for a snapshot generator: those resolve through their own
// package (`resolveGenerator`), they are one-shot rather than long-running, and
// `fli test:snapshots` already runs the set.
//
// ── Lifetime ────────────────────────────────────────────────────────────────
//
// A child dies with the GUI. That is tidy and it is not what somebody who just
// started `api` expects, so it is stated on the page rather than discovered.
// Detaching to OUTLIVE the GUI would buy the expectation and cost the stop
// button, which is the open question in `IDEAS/control-surface.md` §9 and is
// not answered here.
//
// **A child is its own process group and it is stopped as one.** Every command
// on this list is a launcher — `bun run api` is bun running a script that
// spawns the app — so signalling the pid kills the wrapper and leaves what it
// started running. Measured, and expensively: a test that started `bun run
// test` was stopped, reported stopped, and left a tree of suites running that
// went on spawning. For a server the same shape is quieter and worse — stop
// answers 200 and the port keeps answering. So `detached: true` puts the child
// at the head of a group and the kill is `-pid`.

import { spawn } from 'node:child_process'
import { join }  from 'node:path'

/** id → { pid, argv, dir, startedAt, lines, exit } */
const children = new Map()

/**
 * id → the LAST run of that row, kept after the process is gone.
 *
 * The child table held an exit code and sixty lines of output and threw both
 * away — `stopRow` deleted the entry and `startRow` overwrote it — so every
 * drive and every suite read `unknown` forever. That is the honest answer to
 * *is it running* and no answer at all to *does it pass*, which is the question
 * somebody actually has about a drive.
 *
 * FACTS only: when, how long, what it exited with, and whether the stop was
 * asked for. The words — passed, failed, stopped — are the page's, because they
 * differ by kind: a suite that exits 0 passed, and a dev server that exits 0 on
 * its own did something nobody has a word for.
 *
 * In memory and session-scoped, deliberately. Persisting it would claim a
 * verdict about a tree that has moved on since, and it would still know nothing
 * about the runs somebody did in a terminal — so the page says *here*.
 */
const history = new Map()

/** How much of a child's output is kept. Enough to see why one died. */
const TAIL = 60

const RUNNERS = new Set(['bun', 'fli'])

/**
 * `fli` is this package's own bin, run under bun — never the one on PATH.
 * Everything else runs as itself.
 */
function resolveArgv(argv, fliRoot) {
  if (argv[0] === 'fli') return ['bun', join(fliRoot, 'bin', 'fli.js'), ...argv.slice(1)]
  return argv
}

/**
 * Start a row.
 *
 * @param {{id: string, argv: string[]|null, dir: string, name: string}} row
 * @param {{root: string, fliRoot: string, spawnFn?: Function}} opts
 * @returns {{ok: true, pid: number} | {ok: false, status: number, error: string}}
 */
export function startRow(row, { root, fliRoot, spawnFn = spawn } = {}) {
  if (!row?.argv?.length) {
    return { ok: false, status: 400, error: `${row?.name ?? 'this'} declares nothing that starts it` }
  }
  if (!RUNNERS.has(row.argv[0])) {
    // Named rather than silently ignored: the person can still run it, and the
    // line they need is the one they are looking at.
    return {
      ok: false, status: 400,
      error: `this page starts ${[...RUNNERS].join(' and ')} commands. Run it yourself: ` +
             `cd ${row.dir} && ${row.argv.join(' ')}`,
    }
  }
  const live = children.get(row.id)
  if (live && !live.exit) return { ok: false, status: 409, error: `${row.name} is already running here (pid ${live.pid})` }

  const [cmd, ...args] = resolveArgv(row.argv, fliRoot)
  const child = spawnFn(cmd, args, {
    cwd:      row.dir === '.' ? root : join(root, row.dir),
    shell:    false,
    env:      { ...process.env, FORCE_COLOR: '1' },
    stdio:    ['ignore', 'pipe', 'pipe'],
    // Its own process group, so stopping it reaches what it started. Not
    // `unref`ed: it still dies with this process.
    detached: true,
  })

  // A row started again keeps the run before it — without this the record is
  // lost at the moment somebody retries, which is exactly when they want it.
  if (live) archive(row.id, live)

  const entry = {
    pid: child.pid, argv: row.argv, dir: row.dir, kind: row.kind ?? null,
    startedAt: Date.now(), lines: [], exit: null, child, detached: true,
    stopping: false,
  }
  children.set(row.id, entry)

  const keep = (buf) => {
    for (const line of String(buf).split('\n')) {
      if (!line) continue
      entry.lines.push(line)
      if (entry.lines.length > TAIL) entry.lines.shift()
    }
  }
  child.stdout?.on('data', keep)
  child.stderr?.on('data', keep)

  // A child that dies immediately is the case this record exists for: without
  // it the row goes back to `down` and reads as never having started.
  child.on('exit', (code, signal) => {
    entry.exit = { code, signal, at: Date.now() }
    archive(row.id, entry)
  })
  child.on('error', (err) => {
    entry.exit = { code: null, signal: null, at: Date.now(), error: err.message }
    archive(row.id, entry)
  })

  return { ok: true, pid: child.pid }
}

/**
 * Stop a row this table started. Anything else is refused by name.
 */
export function stopRow(id, { name = id } = {}) {
  const entry = children.get(id)
  if (!entry) {
    return {
      ok: false, status: 409,
      error: `${name} was not started here, so this page will not stop it. ` +
             'Stop it where it was started.',
    }
  }
  if (entry.exit) { archive(id, entry); children.delete(id); return { ok: true, alreadyExited: true } }

  // Marked BEFORE the signal, because the exit handler reads it: a row stopped
  // on purpose that reads as `failed` is the page telling somebody their drive
  // broke when they are the one who stopped it.
  entry.stopping = true
  signalGroup(entry, 'SIGTERM')
  archive(id, entry)
  children.delete(id)
  return { ok: true }
}

/**
 * Signal the child's whole process GROUP, falling back to the child alone.
 *
 * The fallback matters: a spawn that was not detached (a test's fake, or a
 * platform that ignores the flag) has no group of its own, and `-pid` would
 * name a group this process may not be allowed to signal — or, worse, is.
 */
function signalGroup(entry, signal) {
  try {
    if (entry.detached && entry.pid) { process.kill(-entry.pid, signal); return }
  } catch {}
  try { entry.child.kill(signal) } catch {}
}

/**
 * Keep what a finished run was, replacing whatever this row's last one was.
 *
 * Called from three places — the exit, a spawn error, and a stop — because a
 * stop does not wait for the exit and a row can be restarted before one
 * arrives. Writing it more than once for a single run is fine and is the point:
 * the later write is the better-informed one.
 */
function archive(id, entry) {
  history.set(id, {
    startedAt: entry.startedAt,
    at:        entry.exit?.at ?? Date.now(),
    ms:        (entry.exit?.at ?? Date.now()) - entry.startedAt,
    exit:      entry.exit ? { ...entry.exit } : null,
    stopped:   Boolean(entry.stopping),
    kind:      entry.kind ?? null,
    lines:     entry.lines.slice(),
  })
}

/** The last finished run of a row, or `null` — no output, which is the bulk. */
export function lastOf(id) {
  const h = history.get(id)
  if (!h) return null
  const { lines, ...rest } = h
  return { ...rest, lineCount: lines.length }
}

/** What this table knows about a row — `null` for one it never started. */
export function childOf(id) {
  const e = children.get(id)
  if (!e) return null
  return { pid: e.pid, startedAt: e.startedAt, exit: e.exit ? { ...e.exit } : null }
}

/**
 * The tail of a row's output, oldest first — the LIVE child's, or the last
 * finished run's once it is gone.
 *
 * The fallback is the whole of why a run is kept: sixty lines saying why a
 * drive failed are worth nothing if they are dropped the moment it does.
 */
export function outputOf(id) {
  return children.get(id)?.lines?.slice() ?? history.get(id)?.lines?.slice() ?? []
}

/** Every id this table holds — the page asks so it knows where to offer stop. */
export function ownedIds() {
  return [...children.keys()]
}

/**
 * Kill everything on the way out.
 *
 * Registered by the server rather than at import, because a module that
 * installs a process listener the moment it is required is one a test cannot
 * import without inheriting it.
 */
export function killAll() {
  for (const [id, e] of children) {
    if (!e.exit) { e.stopping = true; signalGroup(e, 'SIGTERM') }
    archive(id, e)
    children.delete(id)
  }
}

/** Test seam — drop both tables without signalling anything. */
export function _reset() { children.clear(); history.clear() }
