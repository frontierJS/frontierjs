// ─── runnables.js — what can run in this project ─────────────────────────────
//
// One list, one shape, for the two questions a person has when they sit down:
// what can I start here, and what is already up. This module answers only the
// first. Liveness is `ports.js`'s (`busyPorts`, the lock), because a port that
// answers is a fact about the machine and not about the tree.
//
// Every row carries the FILE it came from. That is `repo-map.js`'s rule made
// checkable rather than promised: nothing here is typed twice, so a wrong row
// is traceable to the file that produced it instead of to this module. A list
// somebody maintains is a list that goes stale, which is the failure the page
// this feeds exists to reduce.
//
// ── What is deliberately NOT a row ──────────────────────────────────────────
//
//   commands   — the GUI's sidebar already answers `/api/commands` off the
//                registry. A second list of the same 236 things is the exact
//                duplication this module is arranged against.
//   ci phases  — `scripts/ci.mjs` has no per-phase flag, so a phase tile could
//                only ever run all twelve. The runnable is `bun run ci`, which
//                is a task row, and the phase list stays `repo-map`'s to RENDER
//                rather than to start.
//
// Zero dependencies, plain ESM, node or bun — same rule as `snapshots.js` and
// `checks.js`, because a caller may run before install.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, basename }                        from 'node:path'
import { findSnapshots }                                   from './snapshots.js'
import { GLOBAL, appPorts, hostFor, toolHost, toolBaseHost } from './ports.js'
import { preambleIndex, resolveNeeds }                     from './preflight.js'

// ─── shared tree helpers ──────────────────────────────────────────────────────
//
// Exported because `repo-map.js` reads the same tree the same way, and two
// answers to *where could an app be* is how one of them starts missing a
// directory nobody notices.

export const SKIP = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', '.output', '.vite'])

export function safeRead(dir) { try { return readdirSync(dir).sort() } catch { return [] } }
export function isDir(path)   { try { return statSync(path).isDirectory() } catch { return false } }
export function readJson(path) { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }
export function read(path)     { try { return readFileSync(path, 'utf8') } catch { return null } }

/** Every directory that could hold an app: the root, its children, and packages/*. */
export function appDirs(root) {
  const dirs = [root]
  for (const name of safeRead(root)) {
    if (SKIP.has(name) || name.startsWith('.')) continue
    const child = join(root, name)
    if (!isDir(child)) continue
    dirs.push(child)
    if (name !== 'packages') continue
    for (const inner of safeRead(child)) {
      if (SKIP.has(inner) || inner.startsWith('.')) continue
      if (isDir(join(child, inner))) dirs.push(join(child, inner))
    }
  }
  return dirs
}

/**
 * A directory and everything under it, to a depth.
 *
 * Came here with `findApps`, which is its only caller — `checks.js` keeps its
 * own copy for the rules, which walk with different depths and different skips.
 */
function walk(dir, depth, fn) {
  if (depth < 0 || !existsSync(dir)) return
  try { fn(dir) } catch { /* an unreadable directory is not a finding */ }
  for (const name of safeRead(dir)) {
    if (SKIP.has(name) || name.startsWith('.')) continue
    const child = join(dir, name)
    try { if (statSync(child).isDirectory()) walk(child, depth - 1, fn) } catch { /* dangling link */ }
  }
}

/** Every directory under `root` that looks like an FJS app — one `db/schema.lite`. */
export function findApps(root) {
  const out = []
  walk(root, 4, dir => {
    if (existsSync(join(dir, 'db', 'schema.lite'))) out.push(dir)
  })
  return out
}

/** `.` for the root itself — a row's directory is where the command is typed. */
function where(root, dir) { return relative(root, dir) || '.' }

// ─── surfaces ─────────────────────────────────────────────────────────────────
//
// An app is a directory with a seed (`findApps` below, which is this
// framework's own definition and already the one every rule is graded against),
// and its surfaces are `appPorts()` — the ports schema, asked rather than
// re-derived. A surface the app declares no script for keeps its row with a
// null `start`: the directory exists and nothing here starts it, which is a
// different sentence from the surface not being there.

function surfaces(root) {
  const out = []
  for (const dir of findApps(root)) {
    const pkg  = readJson(join(dir, 'package.json'))
    const rel  = where(root, dir)
    for (const s of appPorts(dir, { name: pkg?.name, scripts: pkg?.scripts })) {
      out.push({
        kind:   'surface',
        id:     `surface:${rel}/${s.surface}`,
        name:   s.label ?? s.surface,
        dir:    rel,
        start:  s.script ? `bun run ${s.script}` : null,
        argv:   s.script ? ['bun', 'run', s.script] : null,
        port:   s.port,
        open:   `http://localhost:${s.port}`,
        // The same port under a name. Derived from the ports table, which
        // already knows this app's id — and additive: `open` stays the number,
        // because nothing may come to depend on a proxy being up.
        host:   hostFor(pkg?.name ?? basename(dir), s.surface),
        needs:  [],
        source: `${rel}/package.json`,
      })
    }
  }
  return out
}

// ─── tools ────────────────────────────────────────────────────────────────────
//
// The reserved 8500–8509 block, read off `ports.js` § GLOBAL so a slot added
// there is a tile here with nothing edited.
//
// Which COMMAND starts one is derived rather than listed, by matching a
// command's own `port` flag default against the reserved number. A hand-written
// name→command table would be the one list in this file that could go stale,
// and the derivation has a second virtue: a tool the schema reserves that no
// command answers for comes back with `start: null` rather than a plausible
// guess. Junction's devtools is honestly one of those — an APP configures it,
// `fli` cannot start it — and `FJS-557` is the other, where studio's command
// defaults to a port the schema has never heard of.

function tools(root, { commands } = {}) {
  const list   = commands ?? commandRows(root)
  const byPort = new Map()
  for (const cmd of list) {
    if (typeof cmd.port === 'number' && !byPort.has(cmd.port)) byPort.set(cmd.port, cmd)
  }

  return Object.entries(GLOBAL).map(([name, port]) => {
    const cmd = byPort.get(port)
    return {
      kind:   'tool',
      id:     `tool:${name}`,
      name,
      dir:    '.',
      start:  cmd ? `fli ${cmd.alias ?? cmd.name}` : null,
      // `fli` as a BINARY name, resolved through the package by whoever runs
      // it rather than off PATH — a globally installed one of a different
      // vintage is exactly the drift the pin in a scaffolded app removes.
      argv:   cmd ? ['fli', cmd.alias ?? cmd.name] : null,
      port,
      open:   `http://localhost:${port}`,
      // `fli.localhost` is the GUI, because that is what a front door is.
      host:   name === 'gui' ? toolBaseHost() : toolHost(name),
      needs:  [],
      source: cmd?.file ?? 'packages/cli/core/ports.js',
    }
  }).sort(byId)
}

// ─── commands ─────────────────────────────────────────────────────────────────
//
// The command tree, read from a ROOT rather than from the registry, because the
// registry resolves its directories off `global.fliRoot` and a module that may
// run before install cannot depend on a global somebody else set. `repo-map.js`
// reads it the same way and now reads it through here.
//
// A command is a markdown file; a nested one is `<ns>/<cmd>/index.md`. The
// `title:` in its frontmatter is how it is actually invoked (`db:seed`), so it
// is read rather than rebuilt from the path — the two disagree often enough
// that a rebuilt name sends someone to a command that does not exist.

export function readCommands(dir, root, trail, depth = 3) {
  if (depth < 0) return []
  const out = []

  for (const name of safeRead(dir)) {
    if (name.startsWith('_') || name.startsWith('.')) continue
    const child = join(dir, name)

    if (isDir(child)) { out.push(...readCommands(child, root, [...trail, name], depth - 1)); continue }
    if (!name.endsWith('.md')) continue

    const head  = read(child)?.slice(0, 1200) ?? ''
    const stem  = name.replace(/\.md$/, '')
    const path  = [...trail, stem === 'index' ? null : stem].filter(Boolean)

    out.push({
      name:        head.match(/^title:\s*(.+)$/m)?.[1].trim() ?? path.join(':'),
      description: head.match(/^description:\s*(.+)$/m)?.[1].trim() ?? '',
      // What a person types. `fli:gui` is the title and `gui` is the alias, and
      // the alias is the one on the boot line and in every example.
      alias:       head.match(/^alias:\s*(.+)$/m)?.[1].trim() ?? null,
      ns:          trail[0] ?? path[0] ?? '',
      file:        relative(root, child).split('\\').join('/'),
      // The default this command's `--port` flag declares, which is how a tool
      // in the reserved block is matched to the command that starts it. Absent
      // where the command takes no port, which is almost all of them.
      port:        portDefault(head),
    })
  }

  return out
}

/** `port:` under `flags:`, and its `defaultValue`. Null where there is none. */
function portDefault(head) {
  const m = head.match(/^\s*port:\s*$[\s\S]{0,300}?^\s*defaultValue:\s*(\d+)\s*$/m)
  return m ? Number(m[1]) : null
}

/** Every command this workspace ships, or none — a client app has no tree. */
function commandRows(root) {
  const dir = join(root, 'packages', 'cli', 'commands')
  if (!existsSync(dir)) return []
  return readCommands(dir, root, [])
}

// ─── drives and suites ────────────────────────────────────────────────────────
//
// Both are package.json scripts and they are separated by name, because they
// answer different questions: a suite proves one package, a drive proves a
// change end to end. `dir` is load-bearing on both — the runner differs per
// package, and `bun test` where the script says `bun run test` is ~35 failures
// that belong to nothing.

export function driveRows(root) {
  const out = []
  for (const dir of appDirs(root)) {
    const pkg = readJson(join(dir, 'package.json'))
    if (!pkg?.scripts) continue
    for (const [name, run] of Object.entries(pkg.scripts)) {
      if (!/^verify/.test(name)) continue
      out.push({ where: where(root, dir), script: name, run })
    }
  }
  return out.sort((a, b) => (a.where + a.script).localeCompare(b.where + b.script))
}

function drives(root) {
  return driveRows(root).map(d => ({
    kind:   'drive',
    id:     `drive:${d.where}/${d.script}`,
    name:   d.script,
    dir:    d.where,
    start:  `bun run ${d.script}`,
    argv:   ['bun', 'run', d.script],
    port:   null,
    open:   null,
    // §7 — a drive's preamble is prose and an exit-1 string today. Empty is
    // honest; a guess here would be a third copy of it.
    needs:  [],
    source: `${d.where}/package.json`,
  }))
}

function suites(root) {
  const out = []
  for (const dir of appDirs(root)) {
    const pkg = readJson(join(dir, 'package.json'))
    if (typeof pkg?.scripts?.test !== 'string') continue
    const rel = where(root, dir)
    // The workspace root's own `test` fans out to every member; it is a task,
    // not a suite, and listing it as one would put a 20-package run behind a
    // button that looks like a single package's.
    if (rel === '.') continue
    out.push({
      kind:   'suite',
      id:     `suite:${rel}`,
      name:   pkg.name ?? basename(dir),
      dir:    rel,
      // The package's OWN runner. `bun test` instead of `bun run test` runs
      // bun's over whatever it finds, which is the trap this field exists for.
      start:  'bun run test',
      argv:   ['bun', 'run', 'test'],
      port:   null,
      open:   null,
      needs:  [],
      source: `${rel}/package.json`,
    })
  }
  return out.sort(byId)
}

// ─── tasks ────────────────────────────────────────────────────────────────────
//
// The workspace's own scripts that are neither a suite nor a drive — `ci`,
// `typecheck`, `hooks:install`. Read off the root package.json, so a script
// added there is a tile.

// Every app's scripts, not only the workspace's. `db:seed` and `build:site` are
// what a drive's preamble names, and while this read the root alone they were
// not rows at all — so the one thing a start button may be handed, an id from
// the inventory, did not exist for the two steps most drives begin with.
//
// A script already claimed by a more specific kind is not a task: `api` is a
// surface and `verify:live` a drive, and the claim is tested on the COMMAND
// rather than the name, because a surface is named for the surface (`API`) and
// not for the script that starts it (`api`).
function tasks(root, claimed) {
  const out = []
  // The workspace and its APPS, not every package. A package's scripts are its
  // own business and are reached through its suite; an app's scripts ARE its
  // control surface, which is what this page is — and 144 rows in one group is
  // an inventory nobody reads.
  for (const dir of [root, ...findApps(root)]) {
    const rel = where(root, dir)
    const pkg = readJson(join(dir, 'package.json'))
    for (const [name, run] of Object.entries(pkg?.scripts ?? {})) {
      if (/^verify/.test(name)) continue
      const start = `bun run ${name}`
      if (claimed.has(`${rel} ${start}`)) continue
      out.push({
        kind:   'task',
        id:     rel === '.' ? `task:${name}` : `task:${rel}/${name}`,
        name,
        dir:    rel,
        start,
        argv:   ['bun', 'run', name],
        port:   null,
        open:   null,
        needs:  [],
        source: `${rel === '.' ? '' : rel + '/'}package.json`,
        run,
      })
    }
  }
  return out.sort(byId)
}

// ─── snapshots ────────────────────────────────────────────────────────────────
//
// Every committed `*.snapshot.*` names the command that wrote it in its own
// header, which is what the `snapshots` CI phase reruns with `--check`. So the
// generator IS the start command and there is nothing to derive: `findSnapshots`
// is the one owner and this is a projection of it.
//
// A snapshot naming no generator keeps its row with `start: null` and its error
// carried — the phase fails such a file rather than skipping it, and a tile that
// hid it would be quieter than the check.

function snapshots(root) {
  return findSnapshots({ root }).map(s => ({
    kind:   'snapshot',
    // `file` is already the path from the root and `dir` is its directory, so
    // joining them names `example/db/example/db/access.snapshot.md` — which
    // resolves to nothing and reads as a snapshot that has gone missing.
    id:     `snapshot:${s.file}`,
    name:   s.file.split('/').pop(),
    dir:    s.dir,
    start:  s.argv ? s.argv.join(' ') : null,
    argv:   s.argv ?? null,
    port:   null,
    open:   null,
    needs:  [],
    source: s.file,
    error:  s.error ?? null,
  })).sort(byId)
}

// ─── the list ─────────────────────────────────────────────────────────────────

function byId(a, b) { return a.id.localeCompare(b.id) }

/**
 * Everything this project can start, one flat list.
 *
 * Sorted within each kind and emitted in the order a person reads them — what
 * this app IS, then the tools beside it, then what proves it. Two collects over
 * one tree answer one list: `repo-map` renders a COMMITTED file from the same
 * readers, so a non-deterministic order here is a snapshot that fails on a tree
 * nobody touched.
 *
 * `commands` may be passed in by a caller that already built the registry —
 * the GUI has, for its sidebar — so the tools list costs no second walk.
 */
export function runnables(root, { commands } = {}) {
  const named = [
    ...surfaces(root),
    ...tools(root, { commands }),
    ...drives(root),
    ...suites(root),
  ]

  // Tasks last and told what is already claimed, so one script is one row: a
  // surface's `bun run api` must not also appear as a task called `api`.
  const claimed = new Set(named.filter(r => r.start).map(r => `${r.dir} ${r.start}`))
  const rows    = [...named, ...tasks(root, claimed), ...snapshots(root)]

  // A drive's preamble is attached here rather than inside `drives()` because a
  // step resolves to another ROW, and the rows it resolves against are only all
  // built once. `needs` stays `[]` for a drive the table does not name, which is
  // the honest answer: nobody has written its preamble down.
  const index = preambleIndex(root)
  for (const row of rows) {
    if (row.kind !== 'drive') continue
    const p = index.get(`${row.dir}/${row.name}`)
    if (p) row.needs = resolveNeeds(p.needs, row.dir, rows)
  }

  return rows
}

/** The kinds, in render order. Exported so a page groups without a copy. */
export const KINDS = ['surface', 'tool', 'drive', 'suite', 'task', 'snapshot']

// ─── probeState ───────────────────────────────────────────────────────────────
//
// Which of them are up, keyed by the same id. Separate from `runnables()` and
// exported separately because it is a different KIND of answer: the inventory
// is a tree walk that can be cached for seconds, and this touches the network
// and cannot. Only one of them misleads when stale — an old inventory shows a
// row that has been renamed, an old state shows a server that is down as up.
//
// Two callers with different needs, which is why it takes rows rather than a
// root and why the child lookup is passed in: the GUI knows what it started,
// and `project:view` starts nothing and must not have to import a table of
// processes to ask whether an app is answering.
//
// Four answers, and `unknown` is one of them. A row with no port cannot be
// probed at all, and *nothing here can tell* is a different sentence from *not
// running*; collapsing them makes every drive and every suite read as stopped.

export async function probeState(rows, { childOf = () => null, lastOf = () => null, ports } = {}) {
  const { busyPorts, getSessionStatus } = ports ?? await import('./ports.js')

  const withPort = rows.filter(r => typeof r.port === 'number')
  const up       = new Set((await busyPorts(withPort)).map(p => p.port))

  // Every port some session has claimed, whether or not anything answers it.
  // `ports` is keyed by category and each value is a LIST of service slots.
  const claimed = new Set()
  for (const session of getSessionStatus()) {
    for (const slots of Object.values(session?.ports ?? {})) {
      for (const p of [].concat(slots)) if (typeof p === 'number') claimed.add(p)
    }
  }

  const state = {}
  for (const r of rows) {
    const base = typeof r.port !== 'number' ? { state: 'unknown' }
               : up.has(r.port)             ? { state: 'up' }
               : claimed.has(r.port)        ? { state: 'claimed-dead' }
               :                              { state: 'down' }

    // Reported for EVERY kind, including the rows with no port: a suite is
    // `unknown` and can still be running here, and without this a page could
    // start one and then show no way to stop it.
    // The last FINISHED run, which outlives the child and is the only thing on
    // this page that can answer *does it pass* rather than *is it running*.
    const mine = childOf(r.id)
    const last = lastOf(r.id)
    state[r.id] = mine
      ? { ...base, pid: mine.pid, startedAt: mine.startedAt, exit: mine.exit, last }
      : last ? { ...base, last } : base
  }

  return state
}
