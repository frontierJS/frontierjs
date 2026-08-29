/**
 * core/ports.js
 *
 * Port schema:  [ENV][CATEGORY][PROJECT][SERVICE]
 *
 *   ENV      7=test  8=dev  9=prod
 *   CATEGORY 0=fe  1=be  2=widgetDev  3=widgetServe  4=ext  5=tooling
 *            6=siteDev  7=siteServe
 *   PROJECT  0-9  (assigned dynamically by lock manager)
 *   SERVICE  0-9  (per-project slot within a category)
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
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, openSync, writeSync, closeSync, unlinkSync } from 'fs'
import { execSync } from 'child_process'
import { homedir } from 'os'
import { basename, join } from 'path'

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
}

export const GLOBAL = {
  gui:      8500,   // fli web GUI
  pview:    8501,   // fli project:view (FJSChain)
  studio:   8502,   // litestone db studio
  devtools: 8503,   // junction's API console — app.configure(devtools())
  proxy:    8504,   // fli ports:proxy — the FALLBACK when 80 cannot be bound
}

/** The whole reserved block, assigned slots and free ones alike. */
export const GLOBAL_RANGE = { first: 8500, last: 8509 }

// ─── Static project ids ───────────────────────────────────────────────────────
//
// claimSession() hands out the lowest FREE id at runtime, which is right for an
// app somebody scaffolded and wrong for the apps that live in this repo: a
// vite.config.js and a test harness need the same number tomorrow that they had
// today, and two of them wanting one port is exactly the failure this scheme
// exists to stop (`example` and `basecamp` both asked for 5274, and vite hops
// ports silently, so the second one's drive tested the first one's app).
//
// So the repo's own apps are ASSIGNED here and the dynamic allocator starts
// above them. A number is claimed forever; adding an app takes the next one.
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

/** Lowest project id claimSession() may hand out. Below this is assigned above. */
export const DYNAMIC_PROJECT_FLOOR = 10

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
const SURFACE_PORTS = [
  { dir: 'web',       category: 'fe',        scripts: ['web', 'dev:web'],             label: 'web' },
  { dir: 'api',       category: 'be',        scripts: ['api', 'dev:api'],             label: 'API' },
  { dir: 'widgets',   category: 'widgetDev', scripts: ['dev:widgets', 'widgets'],     label: 'widgets' },
  { dir: 'site',      category: 'siteDev',   scripts: ['dev:site', 'site'],           label: 'site' },
  { dir: 'extension', category: 'ext',       scripts: ['dev:extension', 'extension'], label: 'extension' },
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
 * `FLI_PORT_FE` / `FLI_PORT_BE` win where the broker set them — a scaffolded
 * app reads those and the literal in its config is only the static default, so
 * a preflight that ignored them would probe a port nothing is about to use.
 *
 * @param {string} appRoot
 * @param {{name?: string, scripts?: object, env?: 'test'|'dev'|'prod',
 *          exists?: (p: string) => boolean}} [opts]
 * @returns {{port: number, surface: string, label: string, script: string|null}[]}
 */
export function appPorts(appRoot, { name, scripts, env = 'dev', exists } = {}) {
  const here      = exists ?? ((p) => existsSync(p))
  const dirName   = basename(appRoot)
  const projectId = projectIdFor(name, dirName)

  const override = { fe: process.env.FLI_PORT_FE, be: process.env.FLI_PORT_BE }

  const out = []
  for (const s of SURFACE_PORTS) {
    if (!here(join(appRoot, s.dir))) continue
    const stated = override[s.category]
    // The first candidate the app actually declares; `null` where it declares
    // none, which is honest — the surface exists and nothing here starts it.
    const script = scripts
      ? (s.scripts.find(n => typeof scripts[n] === 'string') ?? null)
      : s.scripts[0]

    out.push({
      port:    stated ? Number(stated) : port(s.category, { env, projectId }),
      surface: s.dir,
      label:   s.label,
      script,
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
 * `cd web && vite` tokenises to a `web` that is a directory, and an app whose
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
 * Find the first free port in a category for a given env + project,
 * scanning service slots 0–9 in parallel for speed.
 */
export async function findFreeServicePort(category, env, projectId) {
  const ports = []
  for (let serviceId = 0; serviceId <= 9; serviceId++) {
    ports.push({ serviceId, p: port(category, { env, projectId, serviceId }) })
  }
  // Probe all slots concurrently — typically all are free or one early one is.
  const results = await Promise.all(ports.map(async ({ serviceId, p }) => ({
    serviceId, p, inUse: await isPortInUse(p),
  })))
  const free = results.find(r => !r.inUse)
  return free ? free.p : null
}

// ─── Lock manager ─────────────────────────────────────────────────────────────

const LOCK_DIR  = join(homedir(), '.fli')
const LOCK_FILE = join(LOCK_DIR, 'sessions.lock')

export function readLock() {
  if (!existsSync(LOCK_FILE)) return {}
  try   { return JSON.parse(readFileSync(LOCK_FILE, 'utf8')) }
  catch { return {} }
}

function writeLock(sessions) {
  if (!existsSync(LOCK_DIR)) mkdirSync(LOCK_DIR, { recursive: true })
  // Atomic-ish write: temp file + rename avoids partial-write corruption
  const tmp = LOCK_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(sessions, null, 2))
  renameSync(tmp, LOCK_FILE)
}

function isProcessAlive(pid) {
  try   { process.kill(pid, 0); return true }
  catch { return false }
}

// ─── File-lock helper ─────────────────────────────────────────────────────────
// Best-effort exclusive lock via O_EXCL on a sidecar file. Multiple fli
// processes may compete for sessions.lock; this serializes the read-modify-write.
const LOCK_GUARD = LOCK_FILE + '.guard'

function acquireLock(timeoutMs = 5000) {
  const start = Date.now()
  if (!existsSync(LOCK_DIR)) mkdirSync(LOCK_DIR, { recursive: true })
  while (true) {
    try {
      // O_EXCL: fails if file exists. Atomic.
      const fd = openSync(LOCK_GUARD, 'wx')
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return
    } catch (err) {
      // If guard exists but the holder died, take it over
      try {
        const heldBy = parseInt(readFileSync(LOCK_GUARD, 'utf8'))
        if (heldBy && !isProcessAlive(heldBy)) {
          unlinkSync(LOCK_GUARD)
          continue
        }
      } catch {}
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Could not acquire ${LOCK_GUARD} within ${timeoutMs}ms`)
      }
      // Brief sleep then retry
      try { execSync('sleep 0.05', { stdio: 'pipe' }) } catch {}
    }
  }
}

function releaseLock() {
  try { unlinkSync(LOCK_GUARD) } catch {}
}

/**
 * Claim a project session — assigns a projectId and ports for each
 * requested category. Categories can be a simple array ['fe','be'] or
 * an object with counts { fe: 2, be: 1 } for multiple service slots.
 *
 * @param {string} projectName
 * @param {'test'|'dev'|'prod'} env
 * @param {string[]|Record<string,number>} categories
 * @returns {Promise<{ projectId: number, ports: Record<string, number[]> }>}
 */
export async function claimSession(projectName, env, categories) {
  acquireLock()
  try {
    const sessions = readLock()

    // Evict stale sessions (PID no longer alive)
    for (const [name, session] of Object.entries(sessions)) {
      if (!isProcessAlive(session.pid)) delete sessions[name]
    }

    // If this project is already registered, return existing session
    if (sessions[projectName]) {
      const s = sessions[projectName]
      return { projectId: s.projectId, ports: s.ports }
    }

    // Claim lowest unused project ID. Starts above the statically assigned
    // block — a dynamic claim of 1 would land on `example`'s ports whether or
    // not example is running, and the collision only shows up as a drive
    // talking to the wrong app.
    const usedIds  = new Set(Object.values(sessions).map(s => s.projectId))
    let   projectId = PROJECTS[projectName] ?? DYNAMIC_PROJECT_FLOOR
    while (usedIds.has(projectId)) projectId++
    if (projectId > 9) throw new Error('Maximum concurrent projects (10) reached')

    // Normalise categories to { category: count }
    const catMap = Array.isArray(categories)
      ? Object.fromEntries(categories.map(c => [c, 1]))
      : categories

    // Assign ports — fall back to next service slot if somehow in use
    const ports = {}
    for (const [category, count] of Object.entries(catMap)) {
      ports[category] = []
      let serviceId = 0
      for (let i = 0; i < count; i++) {
        let assigned = null
        while (serviceId <= 9) {
          const p = port(category, { env, projectId, serviceId })
          if (!(await isPortInUse(p))) { assigned = p; serviceId++; break }
          serviceId++
        }
        if (assigned === null) {
          throw new Error(
            `No free service slot for category "${category}" ` +
            `(env=${env}, projectId=${projectId}, requested=${count}, assigned=${ports[category].length})`
          )
        }
        ports[category].push(assigned)
      }
    }

    sessions[projectName] = {
      projectId,
      pid:       process.pid,
      env,
      ports,
      startedAt: new Date().toISOString(),
    }

    writeLock(sessions)

    // Inject into process.env so child processes inherit
    for (const [category, ps] of Object.entries(ports)) {
      if (ps.length === 1) {
        process.env[`FLI_PORT_${category.toUpperCase()}`] = String(ps[0])
      } else {
        ps.forEach((p, i) =>
          process.env[`FLI_PORT_${category.toUpperCase()}_${i}`] = String(p)
        )
      }
    }

    return { projectId, ports }
  } finally {
    releaseLock()
  }
}

export function releaseSession(projectName) {
  const sessions = readLock()
  delete sessions[projectName]
  writeLock(sessions)
}

export function autoRelease(projectName) {
  const cleanup = () => releaseSession(projectName)
  process.on('exit',   cleanup)
  process.on('SIGINT',  () => { cleanup(); process.exit(130) })
  process.on('SIGTERM', () => { cleanup(); process.exit(143) })
}

/**
 * Get enriched status of all sessions — adds alive/stale flag.
 */
export function getSessionStatus() {
  const sessions = readLock()
  return Object.entries(sessions).map(([name, s]) => ({
    name,
    ...s,
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
