/**
 * core/ports.js
 *
 * Port schema:  [ENV][CATEGORY][PROJECT][SERVICE]
 *
 *   ENV      7=test  8=dev  9=prod
 *   CATEGORY 0=fe  1=be  2=widgetDev  3=widgetServe  4=ext  5=tooling
 *            6=siteDev  7=siteServe  8=desktopDev
 *   PROJECT  0-9  (assigned in PROJECTS below; every other app is 0)
 *   SERVICE  0-9  (project 0's dev slot — one per app, see § Dev slots)
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
 * Global tooling (not project-scoped, never dynamic) is the WHOLE of
 * 8500–8509 — dev, tooling, project 0. A tool here is one a person runs
 * beside whatever app they are working on, so it cannot take a number from
 * the app's own row and cannot be handed one at runtime: the URL is typed
 * from memory and has to be the same tomorrow. Assigned slots are in GLOBAL
 * below; the rest of the block is held free so the next one costs a line
 * rather than a collision with an app that already claimed project 0.
 */

import net from 'net'
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, openSync, writeSync, closeSync, unlinkSync, readdirSync } from 'fs'
import { execSync } from 'child_process'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'

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
  gui:      8500,   // fli web GUI
  pmap:     8501,   // fli project:map --as=serve (FJSChain)
  studio:   8502,   // litestone db studio
  devtools: 8503,   // junction's API console — app.configure(devtools())
  proxy:    8504,   // fli ports:proxy — the FALLBACK when 80 cannot be bound
}

/** The whole reserved block, assigned slots and free ones alike. */
export const GLOBAL_RANGE = { first: 8500, last: 8509 }

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
  // frontierjs.dev. Site-only — no api, no SPA — so the slots it uses are
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
  // Guard: the whole of dev/tooling/project-0 is the global block. Reserving
  // only the slots currently assigned would hand the next free one to an app,
  // and the collision surfaces as a tool that has quietly moved — the failure
  // this scheme exists to stop. Test (75xx) and prod (95xx) tooling are not
  // reserved: nobody types those from memory.
  if (env === 'dev' && projectId === 0 && CAT[category] === CAT.tooling) {
    const taken = Object.entries(GLOBAL).map(([n, p]) => `${p} ${n}`).join(', ')
    throw new Error(
      `Ports ${GLOBAL_RANGE.first}–${GLOBAL_RANGE.last} are reserved for global tooling (${taken})`
    )
  }
  return (ENV[env] * 1000) + (CAT[category] * 100) + (projectId * 10) + serviceId
}

/** Decode a port number back into its components */
export function decode(p) {
  const envDigit     = Math.floor(p / 1000)
  const catDigit     = Math.floor((p % 1000) / 100)
  const projectDigit = Math.floor((p % 100) / 10)
  const serviceDigit = p % 10
  const env      = Object.keys(ENV).find(k => ENV[k] === envDigit) ?? `unknown(${envDigit})`
  const category = Object.keys(CAT).find(k => CAT[k] === catDigit) ?? `unknown(${catDigit})`
  return { env, category, projectId: projectDigit, serviceId: serviceDigit }
}

/** An ASSIGNED global port. A free slot inside the reserved block is not one. */
export function isGlobalPort(p) {
  return Object.values(GLOBAL).includes(p)
}

/** Inside the reserved block, assigned or not — what the guard answers. */
export function isReservedToolingPort(p) {
  return p >= GLOBAL_RANGE.first && p <= GLOBAL_RANGE.last
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

// Two naming conventions are live and both are correct. The apps in this repo
// call a surface's script by its own name (`api`, `web`) and `fli new` writes
// `dev:api`/`dev:web`, because there the scripts are composed into one `dev`.
// The refusal prints a script for the person to stop, so it has to name one
// that exists — a message telling somebody to run `bun run api` in an app whose
// script is `dev:api` is a message that wastes their next minute.
//
// `env` is the variable a surface's own config reads its port from, which is
// what lets `fli dev` move it to another slot. The extension has none: its dev
// port is compiled into the unpacked extension the browser has loaded, so it
// stays where jetty.config.js says and is only checked.
const SURFACE_PORTS = [
  { dir: 'web',       category: 'fe',         env: 'FLI_PORT_FE',      scripts: ['web', 'dev:web'],             label: 'web' },
  { dir: 'api',       category: 'be',         env: 'FLI_PORT_BE',      scripts: ['api', 'dev:api'],             label: 'API' },
  { dir: 'widgets',   category: 'widgetDev',  env: 'FLI_PORT_WIDGET',  scripts: ['dev:widgets', 'widgets'],     label: 'widgets' },
  { dir: 'site',      category: 'siteDev',    env: 'FLI_PORT_SITE',    scripts: ['dev:site', 'site'],           label: 'site' },
  { dir: 'extension', category: 'ext',        env: null,               scripts: ['dev:extension', 'extension'], label: 'extension' },
  { dir: 'desktop',   category: 'desktopDev', env: 'FLI_PORT_DESKTOP', scripts: ['dev:desktop', 'desktop'],    label: 'desktop' },
]

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
 * slot `fli dev` last gave this root, and 0 for every other app.
 *
 * @param {string} appRoot
 * @param {{name?: string, scripts?: object, env?: 'test'|'dev'|'prod',
 *          exists?: (p: string) => boolean, slot?: number}} [opts]
 * @returns {{port: number, surface: string, label: string, script: string|null,
 *            category: string, env: string|null}[]}
 */
export function appPorts(appRoot, { name, scripts, env = 'dev', exists, slot } = {}) {
  const here      = exists ?? ((p) => existsSync(p))
  const projectId = projectIdFor(name, basename(appRoot))
  const serviceId = projectId !== PROJECTS.scaffold ? 0 : (slot ?? slotFor(appRoot, { env }) ?? 0)

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
      port:     stated ? Number(stated) : port(s.category, { env, projectId, serviceId: s.env ? serviceId : 0 }),
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
 */
export function pidsOnPort(p) {
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
    out.push({ port: p, env: 'dev', category: 'tooling', project: name ? `fli ${name}` : null, reserved: true })
  }
  for (const [project, projectId] of Object.entries(PROJECTS)) {
    for (const env of Object.keys(ENV)) {
      for (const category of Object.keys(CAT)) {
        if (env === 'dev' && projectId === 0 && category === 'tooling') continue   // the reserved block, already above
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
 * The half `getSessionStatus()` cannot see: ports that are HELD but were never
 * claimed through the broker. Every tool in the reserved block is that shape —
 * studio binds 8502 as a literal — and so is any app somebody started by hand,
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

// ─── Dev slots ────────────────────────────────────────────────────────────────
//
// Project 0 is every app `PROJECTS` does not name, so two of them derive one
// number. `fli dev` gives each app ROOT a service digit of its own and passes
// the ports to the servers it starts as `FLI_PORT_*`, which `fli new`'s configs
// already read: the first app is 8000/8100, the next 8001/8101.
//
// A slot is REMEMBERED per root, not handed out per run. A URL somebody has
// open, an OAuth redirect and a `WEB_URL` in an email all name the port, so an
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
function acquireLock(lockFile, timeoutMs = 5000) {
  const guard = lockFile + '.guard'
  const start = Date.now()
  mkdirSync(dirname(lockFile), { recursive: true })
  while (true) {
    try {
      const fd = openSync(guard, 'wx')
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return guard
    } catch {
      // A holder that died mid-claim leaves the guard behind.
      try {
        const heldBy = parseInt(readFileSync(guard, 'utf8'))
        if (heldBy && !isProcessAlive(heldBy)) { unlinkSync(guard); continue }
      } catch {}
      if (Date.now() - start > timeoutMs) throw new Error(`Could not acquire ${guard} within ${timeoutMs}ms`)
      try { execSync('sleep 0.05', { stdio: 'pipe' }) } catch {}
    }
  }
}

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
 */
export function readsPortVar(appRoot, row, { limit = 2000 } = {}) {
  if (!row.env) return true
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
      try { if (readFileSync(join(dir, e.name), 'utf8').includes(row.env)) return true } catch {}
    }
  }
  return false
}

/**
 * Take this app's dev slot and record it.
 *
 * `vars` is the `FLI_PORT_*` set for the servers `fli dev` starts, returned
 * rather than assigned to `process.env`: under bun a child gets the environment
 * the parent STARTED with, so the assignment reaches nothing. Pass it as `env:`.
 *
 * An app `PROJECTS` names is always slot 0 — its numbers are written into its
 * configs and drives. So is an app whose surfaces ignore their variable.
 * Otherwise: the slot this root had last time, or the lowest one no other app
 * remembers and nothing is listening on, or — all ten remembered — the one
 * whose app ran longest ago, if nothing is listening on it now.
 *
 * Returns the rows `fli dev` checks, at the slot taken. Whether they are FREE is
 * the caller's question: a busy slot of this app's own is refused, not moved.
 *
 * @param {string} appRoot
 * @param {{name?: string, scripts?: object, env?: 'test'|'dev'|'prod', entry?: string,
 *          dry?: boolean, lockFile?: string, exists?: (p: string) => boolean,
 *          movable?: (row: object) => boolean, busy?: (rows: object[]) => Promise<object[]>}} [opts]
 */
export async function claimSession(appRoot, opts = {}) {
  const { name, env = 'dev', dry = false, lockFile = LOCK_FILE } = opts
  const busy      = opts.busy ?? busyPorts
  const movable   = opts.movable ?? ((row) => readsPortVar(appRoot, row))
  const projectId = projectIdFor(name, basename(appRoot))
  const rowsAt    = (slot) => devPorts(appRoot, { ...opts, env, slot })

  const guard = acquireLock(lockFile)
  try {
    const sessions = readLock(lockFile)
    const mine     = sessions[appRoot]

    let slot = 0
    if (projectId === PROJECTS.scaffold && rowsAt(0).every(movable)) {
      slot = mine?.env === env && Number.isInteger(mine.slot)
        ? mine.slot
        : await freeSlot(sessions, appRoot, env, rowsAt, busy)
    }

    const rows = rowsAt(slot)
    const vars = {}
    for (const r of rows) if (r.env) vars[r.env] = String(r.port)
    if (dry) return { projectId, slot, rows, vars }

    const ports = {}
    for (const r of rows) (ports[r.category] ??= []).push(r.port)
    sessions[appRoot] = {
      name:      name ?? basename(appRoot),
      root:      appRoot,
      projectId,
      slot,
      env,
      pid:       process.pid,
      ports,
      startedAt: new Date().toISOString(),
    }
    writeLock(sessions, lockFile)
    return { projectId, slot, rows, vars }
  } finally {
    try { unlinkSync(guard) } catch {}
  }
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

/** Forget a root's slot. */
export function releaseSession(appRoot, { lockFile = LOCK_FILE } = {}) {
  const guard = acquireLock(lockFile)
  try {
    const sessions = readLock(lockFile)
    delete sessions[appRoot]
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
// drive's assertions stop hard-coding the port `CLAUDE.md` also states.
//
// ── Strictly additive ───────────────────────────────────────────────────────
//
// The numbers keep working and nothing here may come to depend on a name.
// `FLI_PORT_FE`/`FLI_PORT_BE`, `strictPort`, every drive and the whole table
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
