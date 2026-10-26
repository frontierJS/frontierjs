/**
 * core/ports.js
 *
 * Port schema:  [ENV][CATEGORY][PROJECT][SERVICE]
 *
 *   ENV      7=test  8=dev  9=prod  — a PROJECT's environment
 *   CATEGORY 0=fe  1=be  2=widgetDev  3=widgetServe  4=ext  5=tooling
 *            6=siteDev  7=siteServe  8=desktopDev
 *   PROJECT  0-9  (assigned in PROJECTS below; every other app is 0)
 *   SERVICE  0-9  (project 0's dev slot — one per app, see § Dev slots)
 *
 * A second checkout of an app — a linked git worktree — puts a BRANCH digit in
 * front: branch N adds N×10000, so branch 1's 8120 is 18120 (§ Branches).
 *
 * A surface that is both WRITTEN against and SERVED as its own origin takes
 * two categories rather than two service slots. `widgets/` and `site/` are
 * both that shape: while one is being written it is a dev server, and once it
 * is built it is a static origin a browser reaches cross-origin from the SPA.
 * Putting the served half in the fe row would say it is the SPA's second
 * server, which is the one thing it is not.
 *
 * Examples:
 *   8000  →  dev / fe      / project 0 / service 0
 *   8010  →  dev / fe      / project 1 / service 0
 *   8100  →  dev / be      / project 0 / service 0
 *
 * Global tooling (not project-scoped, never dynamic) is 5500–5509: a 5 where
 * the env digit goes, because a tool run from `~/` has no project and so no
 * test/dev/prod to be in. A tool here is one a person runs beside whatever
 * app they are working on, so it cannot take a number from the app's own row
 * and cannot be handed one at runtime: the URL is typed from memory and has
 * to be the same tomorrow. Assigned slots are in GLOBAL below; the rest of
 * the block is held free so the next one costs a line, not a renumbering.
 */

import net from 'net'
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, unlinkSync, readdirSync, readlinkSync } from 'fs'
import { execSync, execFileSync } from 'child_process'
import { homedir } from 'os'
import { basename, dirname, join, relative } from 'path'
import { fileURLToPath } from 'url'
import { stripComments } from './codegraph.js'
import { findProjectRoot } from './utils.js'
import { acquireGuard } from './guard.js'

// ─── Schema maps ──────────────────────────────────────────────────────────────

export const ENV = {
  test: 7,
  dev:  8,
  prod: 9,
}

export const CAT = {
  fe:          0,
  be:          1,
  widgetDev:   2,
  widgetServe: 3,
  ext:         4,
  tooling:     5,
  siteDev:     6,
  siteServe:   7,
  // A desktop surface that owns its screens writes them in a browser. It has
  // no served half: the build is compiled into the shell (FJS-D263).
  desktopDev:  8,
}

export const GLOBAL = {
  gui:         5500,   // fli web GUI
  studio:      5502,   // litestone db studio
  devtools:    5503,   // junction's API console — app.configure(devtools())
  proxy:       5504,   // fli ports:proxy — the FALLBACK when 80 cannot be bound
  haven:       5505,   // packages/haven's API — where `fli haven` in a checkout knocks
  havenWeb:    5506,   // packages/haven's browser Haven, proxying to the API above
  havenScenes: 5507,   // packages/haven's scene editor — `fli haven:scenes`
}

/** The whole reserved block, assigned slots and free ones alike. */
export const GLOBAL_RANGE = { first: 5500, last: 5509 }

/** The digit global tooling has where a project port has its env. */
export const GLOBAL_DIGIT = 5

// ─── Static project ids ───────────────────────────────────────────────────────
//
// The repo's own apps are ASSIGNED here: a vite.config.js and a test harness
// need the same number tomorrow that they had today, and two of them wanting
// one port is exactly the failure this scheme exists to stop (`example` and
// `basecamp` both asked for 5274, and vite hops ports silently, so the second
// one's drive tested the first one's app). A number is claimed forever.
//
// Every app this table does not name is project 0 — what `fli new` writes —
// and the table has used all ten digits, so there is no project id left to
// hand one at runtime. They share project 0 by SERVICE digit instead: `fli dev`
// gives each app root a slot of its own (§ Dev slots), so a second scaffolded
// app runs on 8001/8101 beside the first on 8000/8100.
//
//   port = ENV*1000 + CAT*100 + PROJECT*10 + SERVICE   →   dev fe = 80<id>0
//
export const PROJECTS = {
  scaffold:        0,   // whatever `fli new` produces — the default in the templates
  example:         1,
  basecamp:        2,
  'sierra-example': 3,
  css:             4,   // the guide/demo server — frontend only
  'junction-example': 5,
  'litestone-example': 6,
  oracle:             7,   // packages/oracle/mockup — frontend only
  // The process a fleet server runs (`FJS-D29`). It is a BACKEND with no
  // frontend — 8180 dev, 7180 test — and it is in this table rather than left
  // to the dynamic allocator because basecamp's drive starts one and needs the
  // same number tomorrow.
  outpost:            8,
  // frontierjs.com. Site-only — no api, no SPA — so the slots it uses are
  // siteDev 8690 and siteServe 8790, and its drive takes 7790.
  website:            9,
}

// ─── Formula ─────────────────────────────────────────────────────────────────

/**
 * Derive a port from components.
 * port = (ENV * 1000) + (CAT * 100) + (PROJECT * 10) + SERVICE
 */
export function port(category, { env, projectId, serviceId = 0 }) {
  if (!ENV[env])      throw new Error(`Unknown env "${env}" — must be test|dev|prod`)
  if (CAT[category] === undefined) throw new Error(`Unknown category "${category}"`)
  if (projectId < 0 || projectId > 9) throw new Error(`projectId must be 0–9`)
  if (serviceId < 0 || serviceId > 9) throw new Error(`serviceId must be 0–9`)
  return (ENV[env] * 1000) + (CAT[category] * 100) + (projectId * 10) + serviceId
}

/** Decode a port number back into its components */
export function decode(p) {
  const branch = Math.floor(p / BRANCH_STEP)
  p = p % BRANCH_STEP
  const envDigit     = Math.floor(p / 1000)
  const catDigit     = Math.floor((p % 1000) / 100)
  const projectDigit = Math.floor((p % 100) / 10)
  const serviceDigit = p % 10
  const env      = envDigit === GLOBAL_DIGIT ? 'global'
    : Object.keys(ENV).find(k => ENV[k] === envDigit) ?? `unknown(${envDigit})`
  const category = Object.keys(CAT).find(k => CAT[k] === catDigit) ?? `unknown(${catDigit})`
  return { env, category, projectId: projectDigit, serviceId: serviceDigit, branch }
}

/** An ASSIGNED global port. A free slot inside the reserved block is not one. */
export function isGlobalPort(p) {
  return Object.values(GLOBAL).includes(p)
}

/** Inside the reserved block, assigned or not. */
export function isReservedToolingPort(p) {
  return p >= GLOBAL_RANGE.first && p <= GLOBAL_RANGE.last
}

/**
 * Where `fli gui` listens. Run in a project it is THAT project's GUI, so it
 * takes the project's tooling row in the env asked for — 8500 dev, 7500
 * test, 9500 prod for project 0. Run where there is no project there is no
 * env either, and it is the global 5500.
 *
 * A scaffolded app is project 0 beside every other scaffolded app, so its GUI
 * takes the app's slot as its service digit, as its web port does — without
 * it two apps' GUIs both want 8500 while their web ports are 8000 and 8001.
 * A branch moves it like every other port of the checkout.
 */
export function guiPort(appRoot, { env = 'dev', lockFile = LOCK_FILE } = {}) {
  if (!appRoot) return GLOBAL.gui
  let manifest = {}
  try { manifest = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) } catch {}
  const projectId = projectIdFor(manifest.name, basename(appRoot))
  const slot      = projectId === PROJECTS.scaffold ? slotFor(appRoot, { env, lockFile }) ?? 0 : 0
  const branch    = branchFor(appRoot, { lockFile }) ?? 0
  return port('tooling', { env, projectId, serviceId: slot }) + branch * BRANCH_STEP
}

// ─── Which ports does THIS app use ────────────────────────────────────────────
//
// A dev server fails badly rather than loudly when its port is taken, and the
// two runners fail differently: `bun --watch` prints EADDRINUSE and KEEPS
// WATCHING, so the process stays alive and a wrapper waiting on it waits
// forever; vite has `strictPort` and exits, but only after somebody has already
// been confused once.
//
// The worst version is a stale server from an earlier run. It still owns the
// port AND still holds the old database open — including one that has been
// deleted, since an unlinked SQLite file lives on while a handle does — so the
// new server never starts, every request is answered by the ghost, and
// `db:reset` looks like it did nothing.
//
// This is the derivation half of saying so. It reads the SURFACES that exist
// (Invariant 3: a surface is a directory at the app root) rather than a list
// each app keeps, because a list is the thing that goes stale the day somebody
// adds `widgets/`.

// `scripts` is the name a surface's script goes by. The API and web surfaces
// have one, their directory (FJS-D1083); a surface script under any other name
// is no surface script, so the row says `null` rather than naming one the app
// does not run.
//
// `env` is the variable a surface's own config reads its port from, which is
// what lets `fli dev` move it to another slot. The extension has none: its dev
// port is compiled into the unpacked extension the browser has loaded, so it
// stays where jetty.config.js says and is only checked.
const SURFACE_PORTS = [
  { dir: 'web',       category: 'fe',         env: 'FRONTIER_PORT_FE',      scripts: ['web'],                        label: 'web' },
  { dir: 'api',       category: 'be',         env: 'FRONTIER_PORT_BE',      scripts: ['api'],                        label: 'API' },
  { dir: 'widgets',   category: 'widgetDev',  env: 'FRONTIER_PORT_WIDGET',  scripts: ['dev:widgets', 'widgets'],     label: 'widgets' },
  { dir: 'site',      category: 'siteDev',    env: 'FRONTIER_PORT_SITE',    scripts: ['dev:site', 'site'],           label: 'site' },
  { dir: 'extension', category: 'ext',        env: null,               scripts: ['dev:extension', 'extension'], label: 'extension' },
  { dir: 'desktop',   category: 'desktopDev', env: 'FRONTIER_PORT_DESKTOP', scripts: ['dev:desktop', 'desktop'],    label: 'desktop' },
]

/** The categories a dev slot moves — those whose surface reads a variable. */
const SLOTTED = new Set(SURFACE_PORTS.filter(s => s.env).map(s => s.category))

/**
 * Resolve an app's project id.
 *
 * The name is asked for first because it is what the PROJECTS table is keyed
 * by, and the directory second because an app is often called something else on
 * disk. Anything unknown is `scaffold` (0), which is what the templates use and
 * therefore the honest default for an app nobody has assigned a number.
 */
export function projectIdFor(name, dirName) {
  if (PROJECTS[name] !== undefined) return PROJECTS[name]
  const short = String(name ?? '').replace(/^@[^/]+\//, '')
  if (PROJECTS[short] !== undefined) return PROJECTS[short]
  if (PROJECTS[dirName] !== undefined) return PROJECTS[dirName]
  return PROJECTS.scaffold
}

/**
 * The dev ports this app's surfaces will bind.
 *
 * A surface's variable wins where it is set — `fli dev` sets them for the
 * servers it starts, and `tutor` for the app it runs — so a preflight that
 * ignored them would probe a port nothing is about to use. Otherwise the port
 * is the formula at `slot`, which for an app `PROJECTS` does not name is the
 * slot `fli dev` last gave this root, and 0 for every other app — moved by
 * `branch`, the number `fli dev` last gave this root's worktree (§ Branches).
 *
 * @param {string} appRoot
 * @param {{name?: string, scripts?: object, env?: 'test'|'dev'|'prod',
 *          exists?: (p: string) => boolean, slot?: number, branch?: number}} [opts]
 * @returns {{port: number, surface: string, label: string, script: string|null,
 *            category: string, env: string|null}[]}
 */
export function appPorts(appRoot, { name, scripts, env = 'dev', exists, slot, branch } = {}) {
  const here      = exists ?? ((p) => existsSync(p))
  const projectId = projectIdFor(name, basename(appRoot))
  const serviceId = projectId !== PROJECTS.scaffold ? 0 : (slot ?? slotFor(appRoot, { env }) ?? 0)
  const offset    = (branch ?? branchFor(appRoot) ?? 0) * BRANCH_STEP

  const out = []
  for (const s of SURFACE_PORTS) {
    if (!here(join(appRoot, s.dir))) continue
    const stated = s.env ? process.env[s.env] : undefined
    // The first candidate the app actually declares; `null` where it declares
    // none, which is honest — the surface exists and nothing here starts it.
    const script = scripts
      ? (s.scripts.find(n => typeof scripts[n] === 'string') ?? null)
      : s.scripts[0]

    out.push({
      port:     stated ? Number(stated) : port(s.category, { env, projectId, serviceId: s.env ? serviceId : 0 }) + (s.env ? offset : 0),
      surface:  s.dir,
      label:    s.label,
      script,
      category: s.category,
      env:      s.env,
    })
  }
  return out
}

/**
 * Which package scripts a script transitively RUNS.
 *
 * `appPorts` answers what an app's surfaces would bind; this is the other half
 * of the question `fli dev` actually asks, which is what THIS command is about
 * to bind. The two are the same set in a scaffolded app, where `fli new`
 * composes every surface into one `dev` — and they are not in an app whose
 * `dev` starts a subset, which is what every app in this repo does.
 *
 * Anchored on `run`, never on a bare token that happens to be a script name:
 * `cd web && vite` tokenizes to a `web` that is a directory, and an app whose
 * web surface is also called `web` would match it and re-introduce the bug this
 * exists to fix.
 *
 * Returns `null` — not an empty set — when the entry script is absent or runs
 * no other script. That is a script which IS the surface command (a
 * single-surface app, where `fli new` writes `dev` as the command itself), and
 * the honest answer there is "cannot narrow", not "starts nothing".
 */
export function scriptsRunBy(scripts, entry = 'dev') {
  if (!scripts || typeof scripts[entry] !== 'string') return null

  const RUNNER = /\b(?:bun|npm|pnpm|yarn|deno)\b/
  const found  = new Set()
  const seen   = new Set()
  const queue  = [entry]

  while (queue.length) {
    const name = queue.shift()
    if (seen.has(name)) continue
    seen.add(name)

    const body = scripts[name]
    if (typeof body !== 'string') continue

    const tokens = body.split(/\s+/).filter(Boolean)
    for (let i = 0; i < tokens.length; i++) {
      if (!RUNNER.test(tokens[i])) continue
      let j = i + 1
      // Flags may sit either side of `run` — `bun --watch run x`,
      // `bun run --parallel a b`.
      while (j < tokens.length && tokens[j].startsWith('-')) j++
      if (tokens[j] === 'run') j++
      while (j < tokens.length && tokens[j].startsWith('-')) j++
      // Then every consecutive token that names a script this app declares.
      // The first one that does not ends the run — it is a file path, a shell
      // operator, or the next command.
      for (; j < tokens.length; j++) {
        if (typeof scripts[tokens[j]] !== 'string') break
        found.add(tokens[j])
        if (!seen.has(tokens[j])) queue.push(tokens[j])
      }
      i = j - 1
    }
  }

  return found.size ? found : null
}

/**
 * The ports `fli dev` is about to bind.
 *
 * `appPorts` narrowed to the surfaces the app's own `dev` script actually
 * starts. Unnarrowed it refuses on a port this command will never take:
 * `example` has five surfaces and a `dev` that runs two of them, so a storefront
 * left running on 8610 blocked `fli dev` with a message naming a port nothing it
 * was about to start would have used (`FJS-568`).
 *
 * A surface matches on ANY of its candidate script names rather than on the one
 * `appPorts` chose to print, because an app may declare both spellings and run
 * the other one.
 */
export function devPorts(appRoot, opts = {}) {
  const rows  = appPorts(appRoot, opts)
  const names = scriptsRunBy(opts.scripts, opts.entry ?? 'dev')
  if (!names) return rows

  const candidates = new Map(SURFACE_PORTS.map(s => [s.dir, s.scripts]))
  return rows.filter(r => (candidates.get(r.surface) ?? []).some(n => names.has(n)))
}

/**
 * The rows a `dev` script only COMPOSES — `bun run api & bun run web & wait`,
 * `bun run --parallel api web` — so `fli dev` can start each one itself
 * and label its lines. Null for anything else: a `&&` chain, a command that is
 * not a surface script, or a single surface, all of which run as written.
 */
export function composedSurfaces(scripts, rows, entry = 'dev') {
  const body = scripts?.[entry]
  if (typeof body !== 'string') return null

  const byScript = new Map(rows.filter(r => r.script).map(r => [r.script, r]))
  const picked   = []
  for (const token of body.split(/\s+/).filter(Boolean)) {
    if (/^(?:bun|npm|pnpm|yarn)$/.test(token) || token === 'run' || token === '&' || token === 'wait' || token.startsWith('-')) continue
    const row = byScript.get(token)
    if (!row || picked.includes(row)) return null
    picked.push(row)
  }
  return picked.length > 1 ? picked : null
}

/**
 * Which of them are already answering.
 *
 * Bound to 0.0.0.0 rather than 127.0.0.1: an app binds the wildcard address and
 * a probe has to collide with it either way round.
 */
export async function busyPorts(ports) {
  const probed = await Promise.all(ports.map(async (p) => (await isPortInUse(p.port, '0.0.0.0') ? p : null)))
  return probed.filter(Boolean)
}

// ─── Socket probe ─────────────────────────────────────────────────────────────

export function isPortInUse(p, address = '127.0.0.1') {
  return new Promise(resolve => {
    const server = net.createServer()
    server.once('error', () => resolve(true))
    server.once('listening', () => server.close(() => resolve(false)))
    server.listen(p, address)
  })
}

/**
 * Which pids are LISTENING on a port, and what they are.
 *
 * Lived inside `commands/utils/killnode.md` until `ports:status` became the
 * second caller. Two implementations of *what is holding this port* is how
 * `fli kill` and `fli ps` come to disagree about the same number.
 *
 * `-sTCP:LISTEN` is the whole of it: without it lsof also reports every process
 * with an open CONNECTION to the port, so a browser tab pointed at a dev server
 * reads as something holding the port. lsof exits 1 with no output when nothing
 * is listening, which is an answer and not a failure.
 *
 * Unix only. A platform with no lsof gets an empty list rather than a throw —
 * `isPortInUse` already answered the question this only decorates.
 *
 * Linux asks `ss` first: lsof walks every open descriptor on the machine, about
 * a second once a bun API holds a thousand, and `ss` reads the socket table in
 * a fifth of that. `fli dev:desktop` asks before every window. Where `ss` is
 * missing, lsof answers as before.
 */
export function pidsOnPort(p) {
  if (process.platform === 'linux') {
    try {
      const out = execFileSync('ss', ['-ltnpH', `sport = :${p}`], { stdio: ['ignore', 'pipe', 'ignore'] }).toString()
      return [...new Set([...out.matchAll(/pid=(\d+)/g)].map(m => m[1]))]
    } catch { /* no ss — lsof below */ }
  }
  try {
    const out = execSync(`lsof -ti tcp:${p} -sTCP:LISTEN`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    return [...new Set(out.split('\n').map(s => s.trim()).filter(Boolean))]
  } catch { return [] }
}

/** The command line behind a pid, truncated. '' when it cannot be asked. */
export function describeProcess(pid, max = 90) {
  try {
    return execSync(`ps -p ${pid} -o args=`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim().slice(0, max)
  } catch { return '' }
}

/**
 * The working directory behind a pid, or null when it cannot be asked — /proc
 * on Linux, lsof elsewhere. It is what says WHOSE server holds a port: a vite
 * or an API started from an app runs in that app's tree.
 */
export function processCwd(pid) {
  try { return readlinkSync(`/proc/${pid}/cwd`) } catch { /* not Linux, or not ours */ }
  try {
    const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    return out.split('\n').find(l => l.startsWith('n'))?.slice(1) || null
  } catch { return null }
}

/**
 * Every port this schema can NAME — the reserved tooling block, plus each
 * assigned project across every category and env at service slot 0.
 *
 * Deliberately not every one of the 3,000 numbers the formula can produce: a
 * port nothing here would ever hand out is not this schema's to report on, and
 * probing three thousand sockets to say so is a second of somebody's life per
 * run. Service slots above 0 are the same argument — they are handed out at
 * runtime, so the lock file is what knows about them.
 */
export function knownPorts() {
  const out = []
  for (let p = GLOBAL_RANGE.first; p <= GLOBAL_RANGE.last; p++) {
    const name = Object.keys(GLOBAL).find(k => GLOBAL[k] === p)
    out.push({ port: p, env: 'global', category: 'tooling', project: name ? `fli ${name}` : null, reserved: true })
  }
  for (const [project, projectId] of Object.entries(PROJECTS)) {
    for (const env of Object.keys(ENV)) {
      for (const category of Object.keys(CAT)) {
        out.push({ port: port(category, { env, projectId }), env, category, project, reserved: false })
      }
    }
  }
  return out
}

/**
 * Every listening TCP port on this machine, port → pids, from ONE lsof call.
 *
 * The alternative is `isPortInUse` per candidate, and the schema names 250 of
 * them: measured at 4.4s, which is not a status command. One lsof is 0.8s and
 * hands back the pid at the same time, so the walk below needs no second pass.
 *
 * Returns null — not an empty map — where lsof cannot be run, because *nothing
 * is listening* and *nobody asked* have to be told apart: the first is an answer
 * and the second means fall back to the socket probe.
 */
export function listeningPorts() {
  let out
  try {
    out = execSync('lsof -nP -iTCP -sTCP:LISTEN', { stdio: ['ignore', 'pipe', 'ignore'] }).toString()
  } catch (err) {
    // lsof exits 1 with output when some sockets were unreadable, and 1 with
    // none when it is missing. Only the second is a failure to answer.
    out = String(err.stdout ?? '')
    if (!out.trim()) return null
  }
  const map = new Map()
  for (const line of out.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 9) continue
    const pid  = cols[1]
    const addr = cols[cols.length - 2]           // NAME, with `(LISTEN)` after it
    const m    = /:(\d+)$/.exec(addr)
    if (!m) continue
    const p = Number(m[1])
    if (!map.has(p)) map.set(p, new Set())
    map.get(p).add(pid)
  }
  return map
}

/**
 * Ports Docker publishes on the host — `fli ps --docker`.
 *
 * `listeningPorts()` cannot see these: the port is held by docker-proxy, which
 * runs as root, and an unprivileged lsof does not list another user's socket.
 * A container is therefore invisible to `busyKnownPorts()` even when it holds a
 * port the schema names, and a port outside the schema (Meilisearch's 7700)
 * decodes to whatever slot it happens to equal. Docker is the one authority on
 * what it published, so ask it.
 *
 * Returns [] where docker is missing or its daemon is down: no containers is the
 * honest answer to "which are running", and `ps` is not a docker doctor.
 */
export function dockerPorts() {
  let out
  try {
    out = execFileSync('docker', ['ps', '--format', '{{.Names}}\t{{.Image}}\t{{.Ports}}'],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString()
  } catch { return [] }
  return parseDockerPorts(out)
}

/** `0.0.0.0:7700->7700/tcp, [::]:7700->7700/tcp` is one publish, not two. */
export function parseDockerPorts(out) {
  const rows = []
  for (const line of out.split('\n')) {
    const [name, image, ports = ''] = line.split('\t')
    if (!name) continue
    const seen = new Set()
    for (const m of ports.matchAll(/:(\d+)(?:-(\d+))?->(\d+)(?:-\d+)?\/tcp/g)) {
      const first = Number(m[1]), last = Number(m[2] ?? m[1])
      for (let host = first; host <= last; host++) {
        if (seen.has(host)) continue
        seen.add(host)
        rows.push({ port: host, container: Number(m[3]) + (host - first), name, image })
      }
    }
  }
  return rows.sort((a, b) => a.port - b.port)
}

/**
 * The half `getSessionStatus()` cannot see: ports that are HELD but were never
 * claimed through the broker. Every tool in the reserved block is that shape —
 * studio binds 5502 as a literal — and so is any app somebody started by hand,
 * which is most of them. Reporting only the lock file answers "nothing here"
 * while a port is busy, which is the one answer that sends somebody looking in
 * the wrong place.
 *
 * Sorted by port. The probe answers in whatever order the OS hands them back,
 * and a list that reorders itself between two runs cannot be diffed by eye.
 */
export async function busyKnownPorts() {
  const known = knownPorts()
  const live  = listeningPorts()

  const hits = live
    ? known.filter(k => live.has(k.port)).map(k => ({ ...k, pids: [...live.get(k.port)] }))
    // No lsof: the socket probe still answers WHETHER, just not who.
    : (await Promise.all(known.map(async k => (await isPortInUse(k.port, '127.0.0.1')) ? { ...k, pids: [] } : null)))
        .filter(Boolean)

  return hits
    .map(k => ({ ...k, command: k.pids.length ? describeProcess(k.pids[0]) : '' }))
    .sort((a, b) => a.port - b.port)
}

/**
 * One port, asked about directly — `fli ps 8008`.
 *
 * Not a filter over `busyKnownPorts()`: that walk stops at service slot 0, and
 * a port somebody types is as often a slot `fli dev` handed out (8008 is
 * project 0's ninth app) or a number outside the schema altogether. So this
 * probes the one port, decodes it, and names it from the most specific source
 * that knows it — the reserved block, then the lock file's slot, then the
 * project table. `project` is null where none of them does.
 */
export async function portStatus(p, { lockFile = LOCK_FILE } = {}) {
  const pids = pidsOnPort(p)
  const busy = pids.length > 0 || await isPortInUse(p, '127.0.0.1')
  const { env, category, projectId, serviceId, branch } = decode(p)
  const reserved = isReservedToolingPort(p)

  const owner = Object.values(readLock(lockFile)).find(s =>
    Object.values(s.ports || {}).flat().map(Number).includes(p))
  const tool  = Object.keys(GLOBAL).find(k => GLOBAL[k] === p)
  const table = !serviceId && !branch ? Object.keys(PROJECTS).find(k => PROJECTS[k] === projectId) : null
  const project = reserved ? (tool ? `fli ${tool}` : null) : (owner?.name ?? table ?? null)

  return {
    port: p, env, category, projectId, serviceId, branch, project, reserved, busy,
    pids, command: pids.length ? describeProcess(pids[0]) : '',
  }
}

// ─── Dev slots ────────────────────────────────────────────────────────────────
//
// Project 0 is every app `PROJECTS` does not name, so two of them derive one
// number. `fli dev` gives each app ROOT a service digit of its own and passes
// the ports to the servers it starts as `FRONTIER_PORT_*`, which `fli new`'s configs
// already read: the first app is 8000/8100, the next 8001/8101.
//
// A slot is REMEMBERED per root, not handed out per run. A URL somebody has
// open, an OAuth redirect and a `FRONTIER_APP_URL` in an email all name the port, so an
// app has to come back where it was. It is also what keeps the stale-server
// refusal honest: an app whose own slot is busy is refused, and never quietly
// moved beside the ghost that still holds its database open.
//
// A slot is only given to an app whose surfaces read their variable. One that
// ignores it would be probed at 8001 and then bind 8000, so it stays at 0 and
// the refusal names the port it will really take.
//
// The session's pid is the `fli dev` process, which lives exactly as long as
// the servers it runs (`context.exec` is synchronous), so ALIVE needs no signal
// handler. A dead session is an app not running now, and keeps its slot.

const LOCK_DIR  = join(homedir(), '.fli')
const LOCK_FILE = join(LOCK_DIR, 'sessions.lock')

/** Every session, keyed by app root. */
export function readLock(lockFile = LOCK_FILE) {
  if (!existsSync(lockFile)) return {}
  try   { return JSON.parse(readFileSync(lockFile, 'utf8')) }
  catch { return {} }
}

function writeLock(sessions, lockFile) {
  mkdirSync(dirname(lockFile), { recursive: true })
  // temp + rename: a reader never sees half a file
  const tmp = lockFile + '.tmp'
  writeFileSync(tmp, JSON.stringify(sessions, null, 2))
  renameSync(tmp, lockFile)
}

function isProcessAlive(pid) {
  try   { process.kill(pid, 0); return true }
  catch { return false }
}

// Two `fli dev` starting together would both read slot 1 as free.
const acquireLock = (lockFile) => acquireGuard(lockFile + '.guard')

/** The slot this root was last given, or null. Static apps have none. */
export function slotFor(appRoot, { env = 'dev', lockFile = LOCK_FILE } = {}) {
  const s = readLock(lockFile)[appRoot]
  return s && s.env === env && Number.isInteger(s.slot) ? s.slot : null
}

/**
 * Whether a surface's own source reads its port variable.
 *
 * A text search over the surface directory, stopping at the first hit. It is
 * the one fact available without running the app, and it answers the only
 * question asked: would this surface follow a slot, or bind its literal.
 * Comments are blanked first: a config that only MENTIONS the variable still
 * binds its literal.
 *
 * An API on junction never spells the variable: junction reads
 * `FRONTIER_PORT_BE` itself (`config/index.ts`). Judged by text alone every
 * scaffolded app was pinned to slot 0, which is how six came to share it. A
 * surface whose manifest depends on junction follows the slot.
 */
export function readsPortVar(appRoot, row, { limit = 2000 } = {}) {
  if (!row.env) return true
  if (row.env === 'FRONTIER_PORT_BE' && dependsOnJunction(appRoot, row.surface)) return true
  const SKIP = new Set(['node_modules', 'dist', 'public', '.git', 'test', 'tests'])
  const stack = [join(appRoot, row.surface)]
  let seen = 0
  while (stack.length && seen < limit) {
    const dir = stack.pop()
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (e.isDirectory()) { if (!SKIP.has(e.name)) stack.push(join(dir, e.name)); continue }
      if (!/\.(m?[jt]s|cjs)$/.test(e.name)) continue
      seen++
      try { if (stripComments(readFileSync(join(dir, e.name), 'utf8')).includes(row.env)) return true } catch {}
    }
  }
  return false
}

function dependsOnJunction(appRoot, surface) {
  for (const dir of [join(appRoot, surface), appRoot]) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      if (pkg.dependencies?.['@frontierjs/junction'] || pkg.devDependencies?.['@frontierjs/junction']) return true
    } catch { /* no manifest here -- the parent may have one */ }
  }
  return false
}

/**
 * Take this app's dev slot and record it.
 *
 * `vars` is the `FRONTIER_PORT_*` set for the servers `fli dev` starts, returned
 * rather than assigned to `process.env`: under bun a child gets the environment
 * the parent STARTED with, so the assignment reaches nothing. Pass it as `env:`.
 *
 * An app `PROJECTS` names is always slot 0 — its numbers are written into its
 * configs and drives. So is an app whose surfaces ignore their variable.
 * Otherwise: the slot this root had last time, unless an older claim of another
 * app also remembers it (`keepsSlot`); else the lowest one no other app
 * remembers and nothing is listening on, or — all ten remembered — the one
 * whose app ran longest ago, if nothing is listening on it now.
 *
 * Returns the rows `fli dev` checks, at the slot taken. Whether they are FREE is
 * the caller's question: a busy slot of this app's own is refused, not moved.
 *
 * @param {string} appRoot
 * @param {{name?: string, scripts?: object, env?: 'test'|'dev'|'prod', entry?: string,
 *          dry?: boolean, lockFile?: string, exists?: (p: string) => boolean,
 *          movable?: (row: object) => boolean, busy?: (rows: object[]) => Promise<object[]>,
 *          worktreeExists?: (top: string) => boolean}} [opts]
 */
export async function claimSession(appRoot, opts = {}) {
  const { name, env = 'dev', dry = false, lockFile = LOCK_FILE } = opts
  const busy      = opts.busy ?? busyPorts
  const movable   = opts.movable ?? ((row) => readsPortVar(appRoot, row))
  const worktreeExists = opts.worktreeExists ?? existsSync
  const projectId = projectIdFor(name, basename(appRoot))
  const tree      = opts.worktree !== undefined ? opts.worktree : worktreeOf(appRoot)
  const rowsAt    = (slot, branch = 0) => devPorts(appRoot, { ...opts, env, slot, branch })

  const guard = acquireLock(lockFile)
  try {
    const sessions = readLock(lockFile)
    const mine     = sessions[appRoot]
    const moves    = rowsAt(0).every(movable)

    let slot = 0, branch = 0
    if (tree && moves) {
      // Every digit keeps its parent's meaning, the slot included.
      const parent = sessions[join(tree.main, relative(tree.top, appRoot))]
      if (projectId === PROJECTS.scaffold && parent?.env === env && Number.isInteger(parent.slot)) slot = parent.slot
      branch = Number.isInteger(mine?.branch) && mine.branch > 0 ? mine.branch : freeBranch(sessions, appRoot, tree, worktreeExists)
    } else if (projectId === PROJECTS.scaffold && moves) {
      slot = keepsSlot(sessions, appRoot, mine, env)
        ? mine.slot
        : await freeSlot(sessions, appRoot, env, rowsAt, busy)
    }

    const rows = rowsAt(slot, branch)
    const vars = {}
    for (const r of rows) if (r.env) vars[r.env] = String(r.port)
    if (dry) return { projectId, slot, branch, rows, vars }

    const ports = {}
    for (const r of rows) (ports[r.category] ??= []).push(r.port)
    sessions[appRoot] = {
      name:      name ?? basename(appRoot),
      root:      appRoot,
      projectId,
      slot,
      ...(branch ? { branch, repo: tree.repo, worktree: tree.top } : {}),
      env,
      pid:       process.pid,
      ports,
      startedAt: new Date().toISOString(),
    }
    writeLock(sessions, lockFile)
    return { projectId, slot, branch, rows, vars }
  } finally {
    try { unlinkSync(guard) } catch {}
  }
}

/**
 * The scaffold apps in a main checkout that remember `slot` in `env`, keyed by
 * root. A branch entry is left out: a worktree shares its parent's slot by
 * design (§ Branches), so it is not a second owner.
 */
function slotHolders(sessions, env, slot, exceptRoot = null) {
  return Object.entries(sessions)
    .filter(([root, s]) => root !== exceptRoot && s.env === env && s.slot === slot
      && s.projectId === PROJECTS.scaffold && !(Number.isInteger(s.branch) && s.branch > 0))
    .map(([root, s]) => ({ root, ...s }))
}

/**
 * Whether a remembered slot is still this app's to come back to.
 *
 * Once, a slot was reused on the strength of the memory alone, and the lock
 * grew six apps on slot 0 — each refused at 8000 by whichever of the others was
 * running. A slot another app also remembers is kept by a holder that is RUNNING,
 * else by the one that last started longest ago; the newcomer is reallocated.
 */
function keepsSlot(sessions, appRoot, mine, env) {
  if (!(mine?.env === env && Number.isInteger(mine.slot))) return false
  const others = slotHolders(sessions, env, mine.slot, appRoot)
  if (!others.length) return true
  if (others.some(o => isProcessAlive(o.pid))) return false
  const since = s => String(s.startedAt ?? '')
  return others.every(o => since(mine) < since(o))
}

/**
 * Slots more than one app remembers — `fli ps` reports these so the lock cannot
 * rot in silence again. `[{ env, slot, apps: [{ root, name, pid, startedAt }] }]`.
 */
export function slotConflicts(sessions) {
  const seen = new Map()
  for (const [root, s] of Object.entries(sessions)) {
    if (s.projectId !== PROJECTS.scaffold || !Number.isInteger(s.slot)) continue
    if (Number.isInteger(s.branch) && s.branch > 0) continue
    const key = `${s.env}:${s.slot}`
    if (!seen.has(key)) seen.set(key, { env: s.env, slot: s.slot, apps: [] })
    seen.get(key).apps.push({ root, name: s.name, pid: s.pid, startedAt: s.startedAt })
  }
  return [...seen.values()].filter(c => c.apps.length > 1)
}

/**
 * Who holds a port, for a refusal that can name them rather than guess.
 *
 * Each listening pid is matched to a dev slot by its working directory: a vite
 * or an API started from an app runs in that app's tree, whether `fli dev`
 * started it or somebody ran `bun run dev` by hand. `own` says the holder runs
 * from `appRoot` itself — an earlier run of the same app, which is the one
 * `db:reset` cannot get past.
 *
 * `[{ pid, cmd, cwd, own, session }]` — empty when nothing can be asked.
 */
export function whoHolds(port, appRoot, { lockFile = LOCK_FILE } = {}) {
  const sessions = readLock(lockFile)
  const roots    = Object.keys(sessions).sort((a, b) => b.length - a.length)
  const under    = (dir, root) => dir === root || dir.startsWith(root + '/')
  return pidsOnPort(port).map(pid => {
    const cwd     = processCwd(pid)
    const root    = cwd && roots.find(r => under(cwd, r))
    const session = root ? { root, ...sessions[root] } : null
    const own     = Boolean(cwd && appRoot && under(cwd, appRoot))
    return { pid: Number(pid), cmd: describeProcess(pid), cwd, own, session }
  })
}

async function freeSlot(sessions, appRoot, env, rowsAt, busy) {
  const owners = new Map()
  for (const [root, s] of Object.entries(sessions)) {
    if (root === appRoot || s.env !== env || s.projectId !== PROJECTS.scaffold) continue
    owners.set(s.slot, { root, ...s })
  }

  for (let slot = 0; slot <= 9; slot++) {
    if (owners.has(slot)) continue
    if (!(await busy(rowsAt(slot))).length) return slot
  }

  const idle = [...owners.values()]
    .filter(s => !isProcessAlive(s.pid))
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
  for (const s of idle) {
    if ((await busy(rowsAt(s.slot))).length) continue
    delete sessions[s.root]
    return s.slot
  }

  throw new Error(
    'All ten dev slots are taken by apps that are running or whose ports are held. ' +
    'Stop one, or forget an idle one with `fli ports:status --clean`.'
  )
}

// ─── Branches ─────────────────────────────────────────────────────────────────
//
// A second checkout of an app is a linked git worktree — a Workbench branch, or
// one made by hand — and it runs beside the first. A slot cannot separate them:
// a fixed project spends its service digit on its own servers (basecamp's 8121
// mail sink), so the next digit is the parent's sink. So the whole block moves:
// branch N adds N×10000 to every port a surface reads from its variable, and
// every digit keeps its meaning — 18120 is 8120 in branch 1 (`FJS-D841`).
//
// N is the lowest of 1–5 no other worktree of the same repository holds in the
// lock, remembered per worktree like a slot, so every app in one worktree shares
// it. Five is the ceiling: a sixth puts 8120 at 68120. 3–5 sit in Linux's
// ephemeral range, where an outgoing socket can hold a port; `strictPort` then
// refuses loudly, and lowest-free reaches them only when 1 and 2 are taken.
//
// A port a surface writes as a literal does not move, and the app's drives do
// (`FJS-2277`). A branch whose surfaces ignore the variable gets no number, so
// the refusal names the port the server will really take.

export const BRANCH_STEP = 10000
export const MAX_BRANCH  = 5

/**
 * The linked worktree `appRoot` sits in — `{ repo, top, main }`: the shared git
 * directory, this worktree's top and the main checkout's — or null for a main
 * checkout, a directory git does not know, or no git at all.
 */
export function worktreeOf(appRoot) {
  let out
  try {
    out = execFileSync('git', ['-C', appRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir', '--git-dir', '--show-toplevel'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')
  } catch { return null }
  const [repo, gitDir, top] = out
  if (!repo || !top || repo === gitDir) return null
  return { repo, top, main: dirname(repo) }
}

/** The branch number this root's worktree was last given, or null. */
export function branchFor(appRoot, { lockFile = LOCK_FILE } = {}) {
  const s = readLock(lockFile)[appRoot]
  return Number.isInteger(s?.branch) && s.branch > 0 ? s.branch : null
}

// A throwaway checkout (/tmp, an agent's scratchpad) is removed without
// `releaseSession`, and its entry would hold the number for good; five of them
// locked every fix-loop lane out of `portFor`. The directory being gone is the
// one fact that cannot be a worktree between runs, so its entry is dropped.
function freeBranch(sessions, appRoot, tree, worktreeExists) {
  const held = new Set()
  for (const [root, s] of Object.entries(sessions)) {
    if (root === appRoot || !s.branch || s.repo !== tree.repo) continue
    if (s.worktree === tree.top) return s.branch
    if (s.worktree && !worktreeExists(s.worktree)) { delete sessions[root]; continue }
    held.add(s.branch)
  }
  for (let n = 1; n <= MAX_BRANCH; n++) if (!held.has(n)) return n
  throw new Error(
    `All ${MAX_BRANCH} branch port blocks of this repository are held by other worktrees. ` +
    'Archive a branch, or forget an idle one with `fli ports:status --clean`.'
  )
}

/**
 * The port a test binds or a drive reaches, moved by this checkout's branch
 * (`FJS-D857`). A literal in a test stays the parent's number in a branch, so a
 * drive passes against a server running code it was not given.
 *
 * `from` is the caller's `import.meta.url` or any path inside the app; the app
 * root is the one `fli dev` runs at. An app `PROJECTS` does not name gets the
 * dev slot `fli dev` gave this root as the service digit of every category a
 * surface reads from its variable, as `appPorts` does. `project` names a `PROJECTS` row for a
 * server the app's tests start but do not own — basecamp's drive starts an
 * outpost. A linked worktree the lock holds no number for claims one through
 * `claimSession`, so a test and a dev server in one branch cannot disagree
 * (`FJS-D858`); a main checkout never writes the lock.
 *
 *   await portFor(import.meta.url, 'be', { env: 'dev' })           // 8110 · 18110
 *   await portFor(import.meta.url, 'be', { service: 3 })           // 7123 · 17123
 *
 * @param {string} from
 * @param {string} category  a `CAT` key
 * @param {{env?: 'test'|'dev'|'prod', project?: string, service?: number, lockFile?: string}} [opts]
 */
export async function portFor(from, category, { env = 'test', project, service = 0, lockFile = LOCK_FILE } = {}) {
  const appRoot = findProjectRoot(from.startsWith('file:') ? fileURLToPath(from) : from)
  let manifest = {}
  try { manifest = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) } catch {}
  if (project !== undefined && PROJECTS[project] === undefined) {
    throw new Error(`Unknown project "${project}" — one of ${Object.keys(PROJECTS).join(', ')}`)
  }
  const projectId = project !== undefined ? PROJECTS[project] : projectIdFor(manifest.name, basename(appRoot))
  let branch = branchFor(appRoot, { lockFile })
  let slot   = slotFor(appRoot, { env, lockFile })
  if (branch === null && worktreeOf(appRoot)) {
    const claimed = await claimSession(appRoot, { name: manifest.name, scripts: manifest.scripts, lockFile })
    branch = claimed.branch
    slot   = slotFor(appRoot, { env, lockFile })
  }
  // A scaffolded app's surface spends its service digit on the slot `fli dev`
  // gave it, which is what `appPorts` hands the server — a drive asking for the
  // bare formula reaches slot 0, another app's server.
  const slotted = project === undefined && projectId === PROJECTS.scaffold && slot !== null && SLOTTED.has(category)
  if (slotted && service !== 0) {
    throw new Error(`portFor: "${category}" of a scaffolded app takes its service digit from its dev slot (${slot}); service ${service} has no port of its own`)
  }
  return port(category, { env, projectId, serviceId: slotted ? slot : service }) + (branch ?? 0) * BRANCH_STEP
}

/** Forget a root's slot — and every app root inside it, so a removed worktree
 *  gives its branch number back whichever of its apps ran. */
export function releaseSession(appRoot, { lockFile = LOCK_FILE } = {}) {
  const guard = acquireLock(lockFile)
  try {
    const sessions = readLock(lockFile)
    for (const root of Object.keys(sessions))
      if (root === appRoot || root.startsWith(appRoot + '/')) delete sessions[root]
    writeLock(sessions, lockFile)
  } finally {
    try { unlinkSync(guard) } catch {}
  }
}

/** Every session with `alive`: whether its `fli dev` is still running. */
export function getSessionStatus({ lockFile = LOCK_FILE } = {}) {
  return Object.entries(readLock(lockFile)).map(([root, s]) => ({
    ...s,
    root,
    alive: isProcessAlive(s.pid),
  }))
}


// ─── names ────────────────────────────────────────────────────────────────────
//
// `example.localhost` rather than `localhost:8010`, and it is worth having only
// because the derivation is already here: this table knows that project 1 is
// `example`, that 8010 is its frontend and 8110 its API. A name is a RENDERING
// of the table that is already the source of truth for the numbers — nothing is
// configured, invented, or kept in sync.
//
// Browsers resolve `*.localhost` to loopback with no `/etc/hosts` entry, so the
// client half is free. What is not free is that a name has no port, which is
// what `fli ports:proxy` is: one listener mapping Host to port.
//
// ── Three things it fixes, none of them remembering a number ────────────────
//
// `strictPort` exists because vite otherwise hops in silence and the second
// app's drive tests the first app's app — a name makes that unreachable rather
// than merely loud. **Cookie scope stops being a lie**: a port is not part of a
// cookie's origin, so `localhost:8010` and `localhost:8110` share one jar and
// cookie auth in dev behaves unlike cookie auth anywhere else, where
// `example.localhost` and `api.example.localhost` reproduce production. And a
// drive's assertions stop hard-coding the port `docs/PORTS.md` also states.
//
// ── Strictly additive ───────────────────────────────────────────────────────
//
// The numbers keep working and nothing here may come to depend on a name.
// `FRONTIER_PORT_FE`/`FRONTIER_PORT_BE`, `strictPort`, every drive and the whole table
// below are the mechanism; a name is a second way to reach the same port, and a
// DX nicety that becomes load-bearing is a worse trade than the tax it removes.

/** The suffix every dev name ends in. A constant so one edit moves them all. */
export const NAME_BASE = 'localhost'

/** Tools live under one label of their own, so no app can shadow `studio`. */
export const TOOL_BASE = 'fli'

/**
 * A DNS label from a package name — `@frontierjs/basecamp` is `basecamp`.
 *
 * `null` where nothing survives the trim: a name that is not a label cannot be
 * a host, and inventing one would put two apps behind one name.
 */
export function nameLabel(name) {
  const label = String(name ?? '')
    .replace(/^@[^/]+\//, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return label.length ? label : null
}

/**
 * The dev host for one surface of one app.
 *
 * The FRONTEND takes the bare name, because it is the thing somebody opens;
 * every other surface is a subdomain named for its own directory. That is also
 * what makes the cookie property true — `example.localhost` and
 * `api.example.localhost` are a parent and a child, which is production's
 * shape and not `localhost`'s.
 *
 * `null` for a surface with no name, which is every SERVED one: `site` means
 * two ports (8610 written, 8710 served) and a name that could mean either is
 * worse than no name at all.
 */
export function hostFor(name, surface, { base = NAME_BASE } = {}) {
  const label = nameLabel(name)
  if (!label) return null
  if (surface === 'web' || surface === 'fe') return `${label}.${base}`
  if (!NAMED_SURFACES.has(surface)) return null
  return `${surface}.${label}.${base}`
}

/** Which surfaces get a name — the DEV ones, which is what `appPorts` answers. */
const NAMED_SURFACES = new Set(SURFACE_PORTS.map(s => s.dir))

/**
 * The host for a reserved tooling slot — `studio.fli.localhost`.
 *
 * Under one label of their own rather than at the top level, so an app called
 * `studio` and litestone's studio are different names rather than a collision
 * nobody would see until both were running.
 */
export function toolHost(tool, { base = NAME_BASE } = {}) {
  const label = nameLabel(tool)
  return label ? `${label}.${TOOL_BASE}.${base}` : null
}

/** The front door: `fli.localhost` is the GUI, because that is what it is. */
export function toolBaseHost({ base = NAME_BASE } = {}) {
  return `${TOOL_BASE}.${base}`
}

// ─── the container a deploy runs ─────────────────────────────────────────────
//
// The name lives here because it is a function of the TIER, and the tier is
// what this table means. Nine call sites wrote `${appId}-api` by hand, so the
// port scheme separated a test run from a dev run and the container name did
// not — two runs of one lesson on one machine collided on the name while their
// ports were doing exactly what they were designed to do, and docker reported
// it as a name conflict rather than as the collision it was.
//
// Only the TEST tier is suffixed. Every deployed container in the world is
// called `<app>-api` today, and renaming them would orphan the running one:
// `deploy:stop`, `deploy:logs` and a revert all address the name, so a machine
// mid-upgrade would have a container nothing could reach. The collision that
// actually happens is CI against a person, and that is the tier boundary.
export function apiContainerName(appId, port) {
  const tier = Number.isFinite(port) ? decode(Number(port)).env : null
  return tier === 'test' ? `${appId}-api-test` : `${appId}-api`
}
