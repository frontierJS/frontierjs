// ─── server.js ────────────────────────────────────────────────────────────────
// Thin HTTP wrapper around the FLI runtime.
// Same Command() call as the CLI — only the input source and output method differ.
//
// Endpoints:
//   GET  /api/commands        → array of all command metadata (for nav/sidebar)
//   GET  /api/commands/:name  → single command metadata (for form rendering)
//   POST /api/run/:name       → SSE stream, runs command, emits output as events
//
// And the control surface's own four, which are the front page rather than the
// sidebar — what could run, which of them are up, which of them prove the change
// in the working tree, and the process table behind a start button:
//   GET  /api/runnables       → the inventory, cached on the registry's TTL
//   GET  /api/state           → probed per poll, four answers, `unknown` is one
//   GET  /api/proves          → CLAUDE.md's proof table against `git diff`
//   GET  /api/health/:id      → what the thing on that port says about itself
//   GET  /api/check           → the architecture rules over this project's apps
//   GET  /api/doctor          → can this machine run fli
//   POST /api/start/:id · POST /api/stop/:id · GET /api/output/:id
//
// SSE event shapes sent to client:
//   data: {"type":"output","text":"Hello, World!\n"}
//   data: {"type":"log","level":"success","text":"Done"}
//   data: {"type":"done"}
//   data: {"type":"error","text":"arg [name] is required!"}
// ─────────────────────────────────────────────────────────────────────────────

import { createServer }  from 'http'
import { execFileSync }  from 'child_process'
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { basename } from 'path'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { homedir } from 'os'

const __dir = dirname(fileURLToPath(import.meta.url))
import { buildRegistry, uniqueCommands, getModule } from './registry.js'
import { Command } from './runtime.js'
import { extractSegments, stripFrontmatter } from './compiler.js'

import { GLOBAL } from './ports.js'
import { ownStyleBundle, glowSource, CDN_STYLESHEET } from './assets.js'
const PORT = parseInt(process.env.FLI_PORT) || GLOBAL.gui

// ─── Registry cache ───────────────────────────────────────────────────────────
// buildRegistry() walks the filesystem and reads every .md file — expensive
// to do on every API call. Cache results for a short TTL so back-to-back
// requests (sidebar load + meta fetch + run) share one scan, while edits made
// during a session show up within a few seconds without manual refresh.
let _cachedRegistry = null
let _cacheTime = 0
const REGISTRY_TTL_MS = 2000

function getRegistry() {
  const now = Date.now()
  if (!_cachedRegistry || now - _cacheTime > REGISTRY_TTL_MS) {
    _cachedRegistry = buildRegistry()
    _cacheTime = now
  }
  return _cachedRegistry
}

// ─── Router ───────────────────────────────────────────────────────────────────

function route(req, res) {
  const url  = new URL(req.url, `http://localhost`)
  const path = url.pathname

  // CORS — allow the frontend to run on any origin during dev
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  // GET /fli.css, /glow.js — the styling language the GUI is written in, and
  // the highlighter whose output that stylesheet themes
  if (req.method === 'GET' && path === '/fli.css') {
    return handleStylesheet(res)
  }
  if (req.method === 'GET' && path === '/glow.js') {
    return handleGlow(res)
  }

  // GET / and any non-API path — serve the Web GUI (client handles routing)
  if (req.method === 'GET' && !path.startsWith('/api/')) {
    return handleStatic(res)
  }

  // GET /api/commands
  if (req.method === 'GET' && path === '/api/commands') {
    return handleList(req, res)
  }

  // GET /api/commands/:name
  const commandMatch = path.match(/^\/api\/commands\/(.+)$/)
  if (req.method === 'GET' && commandMatch) {
    return handleMeta(req, res, decodeURIComponent(commandMatch[1]))
  }

  // GET /api/meta — version and build info
  if (req.method === 'GET' && path === '/api/meta') {
    return handleMeta_info(req, res)
  }

  // GET /api/runnables — what this project can start
  if (req.method === 'GET' && path === '/api/runnables') {
    return handleRunnables(req, res)
  }

  // GET /api/state — which of them are up
  if (req.method === 'GET' && path === '/api/state') {
    return handleState(req, res)
  }

  // GET /api/proves — which of them prove what you have changed
  if (req.method === 'GET' && path === '/api/proves') {
    return handleProves(req, res)
  }

  // GET /api/check — the architecture rules over this project's own apps
  if (req.method === 'GET' && path === '/api/check') {
    return handleCheck(req, res)
  }

  // GET /api/doctor — can this machine run fli
  if (req.method === 'GET' && path === '/api/doctor') {
    return handleDoctor(req, res)
  }

  // GET /api/release — the pivot verdict for every app in this tree
  if (req.method === 'GET' && path === '/api/release') {
    return handleRelease(req, res)
  }

  // POST /api/release/target — what is serving out there, and can it come back.
  // POST because it reaches a machine: a GET that ssh'd would be fetched by a
  // link preview and a browser's own prefetch.
  if (req.method === 'POST' && path === '/api/release/target') {
    return handleReleaseTarget(req, res)
  }

  // GET /api/health/:id — what the thing on that port says about itself
  const healthMatch = path.match(/^\/api\/health\/(.+)$/)
  if (req.method === 'GET' && healthMatch) {
    return handleRowHealth(req, res, decodeURIComponent(healthMatch[1]))
  }

  // POST /api/start/:id — start a row the inventory declares
  const startMatch = path.match(/^\/api\/start\/(.+)$/)
  if (req.method === 'POST' && startMatch) {
    return handleStart(req, res, decodeURIComponent(startMatch[1]))
  }

  // POST /api/stop/:id — stop one this server started
  const stopMatch = path.match(/^\/api\/stop\/(.+)$/)
  if (req.method === 'POST' && stopMatch) {
    return handleStop(req, res, decodeURIComponent(stopMatch[1]))
  }

  // GET /api/output/:id — the tail of a started row's output
  const outMatch = path.match(/^\/api\/output\/(.+)$/)
  if (req.method === 'GET' && outMatch) {
    return handleOutput(req, res, decodeURIComponent(outMatch[1]))
  }

  // GET /api/ports — current session status
  if (req.method === 'GET' && path === '/api/ports') {
    return handlePorts(req, res)
  }

  // POST /api/ports/clean — remove a stale session by name
  if (req.method === 'POST' && path === '/api/ports/clean') {
    return handlePortsClean(req, res)
  }

  // GET /api/ports/schema — port formula constants
  if (req.method === 'GET' && path === '/api/ports/schema') {
    return handlePortsSchema(req, res)
  }

  // GET /api/env — serve the global fli env file contents
  if (req.method === 'GET' && path === '/api/env') {
    return handleEnv(req, res)
  }

  // POST /api/env — save the global fli env file
  if (req.method === 'POST' && path === '/api/env') {
    return handleEnvSave(req, res)
  }

  // POST /api/run/:name
  const runMatch = path.match(/^\/api\/run\/(.+)$/)
  if (req.method === 'POST' && runMatch) {
    return handleRun(req, res, decodeURIComponent(runMatch[1]))
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Not found' }))
}

// ─── GET /api/meta ────────────────────────────────────────────────────────────
function handleMeta_info(req, res) {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dir, '../package.json'), 'utf8'))
    json(res, 200, {
      version: pkg.version || null,
      built:   pkg._built  || null,
      name:    pkg.name    || 'fli',
    })
  } catch {
    json(res, 200, { version: null, built: null, name: 'fli' })
  }
}

// ─── GET /api/release ────────────────────────────────────────────────────────
//
// The local half: what a deploy of this tree would be, per app. Reads the tree
// and touches nothing else, which is what makes it safe on page load beside the
// other panels. The remote half is a button — see below.
async function handleRelease(req, res) {
  try {
    const { releaseLocal } = await import('./release-view.js')
    json(res, 200, await releaseLocal({ root: global.projectRoot, fliRoot: global.fliRoot }))
  } catch (err) {
    json(res, 500, { error: err.message })
  }
}

// ─── POST /api/release/target ────────────────────────────────────────────────
//
// The remote half. Reaches a real machine over ssh, so it is never polled and
// never on page load; the panel calls it when somebody presses the button.
//
// The target is caller-supplied and is checked against `TARGETS` by KEY before
// it becomes argv (Invariant 8). The app is matched exactly against the tree's
// own list rather than joined onto a path.
async function handleReleaseTarget(req, res) {
  let body
  try { body = await readBody(req) } catch { return json(res, 400, { error: 'Invalid JSON body' }) }

  try {
    const { releaseTarget } = await import('./release-view.js')
    const out = await releaseTarget({
      root:   global.projectRoot,
      fliRoot: global.fliRoot,
      target: String(body?.target ?? 'default'),
      app:    body?.app ? String(body.app) : null,
    })
    json(res, out.ok ? 200 : 400, out)
  } catch (err) {
    json(res, 500, { error: err.message })
  }
}

// ─── GET /api/ports ───────────────────────────────────────────────────────────
async function handlePorts(req, res) {
  try {
    const { getSessionStatus, GLOBAL } = await import('./ports.js')
    const sessions = getSessionStatus()
    json(res, 200, { sessions, global: GLOBAL })
  } catch (err) {
    json(res, 500, { error: err.message })
  }
}

// ─── GET /api/runnables ──────────────────────────────────────────────────────
//
// The inventory. Cached on the same TTL the command registry uses, because both
// walk the filesystem and a page polling state must not re-walk the tree on
// every tick.
//
// The commands are handed over rather than re-read: this server has already
// built the registry for its sidebar, and the tools list only needs each
// command's name and its `--port` default.

let _cachedRunnables = null
let _runnablesAt     = 0

async function handleRunnables(req, res) {
  try {
    const now = Date.now()
    if (!_cachedRunnables || now - _runnablesAt > REGISTRY_TTL_MS) {
      const { runnables, KINDS } = await import('./runnables.js')
      _cachedRunnables = { rows: runnables(global.projectRoot), kinds: KINDS }
      _runnablesAt     = now
    }
    json(res, 200, _cachedRunnables)
  } catch (err) {
    json(res, 500, { error: err.message })
  }
}

// ─── GET /api/state ──────────────────────────────────────────────────────────
//
// Which rows are up, keyed by the same id. A poll rather than a stream: the
// server pushes command OUTPUT over SSE because there is an event to push, and
// there is no event for a port somebody else bound — a probe is a question
// somebody has to ask.
//
// Four answers and `unknown` is one of them. A row with no port cannot be
// probed at all, and *nothing here can tell* is a different sentence from *not
// running*; collapsing them makes every drive and every suite read as down.
//
// `claimed-dead` is a lock claim over a port nothing answers, which is the
// failure the lock file already exists for and the one a person needs told.

async function handleState(req, res) {
  try {
    const { runnables, probeState } = await import('./runnables.js')
    const { childOf, lastOf }       = await import('./children.js')

    const state = await probeState(runnables(global.projectRoot), { childOf, lastOf })
    json(res, 200, { at: new Date().toISOString(), state })
  } catch (err) {
    json(res, 500, { error: err.message })
  }
}

// ─── GET /api/proves ─────────────────────────────────────────────────────────
//
// The other question this page can answer that a terminal cannot: not *what
// can run* but *what should I run, for what I have just changed*. Every answer
// is already a row with an id, so the panel presses the same button the tiles
// below it do.
//
// The working tree, and only the working tree. `fli proves --from <ref>` takes
// a ref because a person typing one has already chosen it; a ref arriving over
// HTTP is caller-supplied text on a git command line, and the branch view is
// not worth that. So there is no parameter here at all.
//
// Never cached. A refresh button answering a cached read is a broken refresh,
// and this is a git call rather than a tree walk — it is asked when somebody
// asks, and the page does not poll it.

async function handleProves(req, res) {
  try {
    const root = global.projectRoot
    // `execFileSync`, not a shell: nothing here is caller-supplied and it stays
    // that way by construction rather than by a validator somebody can loosen.
    const git = (argv) => {
      try { return execFileSync('git', ['-C', root, ...argv], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }) }
      catch { return '' }
    }

    // Git answers paths from the repository root, which is the project root
    // only when the two are the same directory. A project one level down would
    // otherwise be matched against paths carrying a prefix its own table never
    // writes — matching nothing, or worse, matching the wrong row.
    const top    = git(['rev-parse', '--show-toplevel']).trim()
    const prefix = top && resolve(top) !== resolve(root)
      ? `${git(['rev-parse', '--show-prefix']).trim()}`
      : ''

    const files = git(['diff', '--name-only', 'HEAD']).trim().split('\n')
      .filter(Boolean)
      .filter(f => !prefix || f.startsWith(prefix))
      .map(f => f.slice(prefix.length))

    if (!files.length) return json(res, 200, { at: new Date().toISOString(), files: [], rows: [] })

    const diff = git(['diff', '-U0', 'HEAD'])

    const { provesFor } = await import('./proofs.js')
    const { runnables } = await import('./runnables.js')
    const rows = provesFor(root, { files, diff, rows: runnables(root) })

    json(res, 200, { at: new Date().toISOString(), files, rows })
  } catch (err) {
    json(res, 500, { error: err.message })
  }
}

// ─── GET /api/check · GET /api/doctor ────────────────────────────────────────
//
// Two engines that existed and were nowhere a person looks. `fli check` grades
// the PROJECT against the rules this framework publishes; `fli doctor` grades
// the MACHINE the commands are about to run on. They stay two questions,
// because a missing `sqlite3` is not an architecture finding and a model named
// in the plural is not something `apt` can fix.
//
// **Called in process, not spawned.** `core/checks.js` is the same engine
// `scripts/ci.mjs` runs and `core/doctor.js` is the one the command renders, so
// there is no `--json` to parse and no second answer to either question. That
// is the rule `proofs.js` is already read by.
//
// Not cached and not polled: both walk the tree, and the page asks on load and
// on a button. A findings list that refreshed every three seconds would cost
// more than the findings are worth.

async function handleCheck(req, res) {
  try {
    const root = global.projectRoot
    const { runChecks, findApps } = await import('./checks.js')
    const { relative }            = await import('path')

    // Per app, then the workspace's own rules — the same two passes the
    // `structure` CI phase makes, so a rule loosened for one is loosened for
    // both. An app is a directory with a seed, which is this framework's own
    // definition and already what every rule is graded against.
    const scopes = findApps(root).map(dir => ({ label: relative(root, dir) || '.', root: dir, scope: 'app' }))
    scopes.push({ label: 'packages', root, scope: 'repo' })

    const out = []
    for (const s of scopes) {
      // `runChecks` is synchronous and one scope is ~half a second, so five in
      // a row freeze this server — the state poll misses, every badge on the
      // page empties, and a start button does nothing for a second and a half.
      // Yielding between them does not make it faster; it makes the server
      // answerable while it runs.
      await new Promise(setImmediate)
      const r = runChecks({ root: s.root, scope: s.scope })
      out.push({
        label:    s.label,
        dir:      s.scope === 'repo' ? '.' : s.label,
        ran:      r.ran.length,
        skipped:  r.skipped.length,
        findings: r.findings.map(f => ({
          rule: f.rule, severity: f.severity, line: f.line ?? null,
          file: f.file ? relative(root, f.file) : null,
          message: f.message,
        })),
      })
    }

    json(res, 200, {
      at: new Date().toISOString(),
      scopes: out,
      errors: out.reduce((n, s) => n + s.findings.filter(f => f.severity === 'error').length, 0),
      warns:  out.reduce((n, s) => n + s.findings.filter(f => f.severity !== 'error').length, 0),
    })
  } catch (err) {
    json(res, 500, { error: err.message })
  }
}

async function handleDoctor(req, res) {
  try {
    const { diagnose, requiringModules } = await import('./doctor.js')
    const { getModule }                  = await import('./registry.js')

    // The registry this server already built for its sidebar, rather than a
    // second walk of the command tree.
    const modules = requiringModules({ commands: uniqueCommands(getRegistry()), getModule })
    json(res, 200, {
      at: new Date().toISOString(),
      ...diagnose({ root: global.projectRoot, fliRoot: global.fliRoot, modules }),
    })
  } catch (err) {
    json(res, 500, { error: err.message })
  }
}

// ─── GET /api/health/:id ─────────────────────────────────────────────────────
//
// A port answering is not an app working. `busyPorts` opens a socket, which is
// true of a Junction app whose database probe is failing and of a process that
// bound the port and then wedged — so the page said `answering` about both.
// Junction answers `/health` with a named check per plugin, and this is the one
// reader of it here.
//
// **Fetched by this server and not by the page.** The page is on 8500 and the
// app is on 8110, so a browser fetch is cross-origin: an app whose CORS does
// not name this origin answers a network error that is indistinguishable from
// the app being down, which is the opposite of what this is for.
//
// **The path is PROBED and the answer says which one worked.** `apiPrefix`
// moves every route an app registers, `/health` included, so the path is a fact
// about the app's config rather than about its port. Invariant 3's rule for the
// same class of question: probe, or be told — never derive.
//
// THREE answers, and the third is the one worth having: `ok`, `degraded`, and
// *nothing here answers a health question* — which is the honest state of a
// Vite dev server, a static origin and a widget host, and is not a failure.

const HEALTH_PATHS   = ['/health', '/api/health']
const HEALTH_TIMEOUT = 2000

async function handleRowHealth(req, res, id) {
  try {
    const row = await rowById(id)
    if (!row)             return json(res, 404, { error: `no runnable called ${id}` })
    if (!row.port)        return json(res, 200, { id, answered: false, why: 'this row has no port' })

    for (const path of HEALTH_PATHS) {
      const body = await askHealth(`http://localhost:${row.port}${path}`)
      if (body) return json(res, 200, { id, answered: true, path, health: body })
    }

    // Not a failure. A Vite dev server is up and has nothing to say about its
    // own readiness, and reporting that as unhealthy would make every web
    // surface on the page permanently red.
    json(res, 200, { id, answered: false, why: `nothing answered ${HEALTH_PATHS.join(' or ')}` })
  } catch (err) {
    json(res, 500, { error: err.message })
  }
}

/** The parsed body if it looks like a health answer, else null. */
async function askHealth(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(HEALTH_TIMEOUT) })
    if (!r.ok) return null
    const body = await r.json()
    // A 200 of something else is not a health answer. `status` and `checks` are
    // what every reader of this shape uses, so requiring them is what keeps a
    // web app's index page from being read as a healthy API.
    return body && typeof body.status === 'string' && body.checks ? body : null
  } catch { return null }
}

// ─── POST /api/start/:id · POST /api/stop/:id · GET /api/output/:id ──────────
//
// The caller sends an ID and never a command. What runs comes from the
// inventory, which comes from a file in the tree — so a request can choose
// among the project's own declared commands and cannot name one of its own.
//
// The stop refusal is the design and not an omission: this server stops what it
// started and says so about anything else, because the alternative is a button
// that kills a process somebody else is depending on.

async function rowById(id) {
  const { runnables } = await import('./runnables.js')
  return runnables(global.projectRoot).find(r => r.id === id) ?? null
}

async function handleStart(req, res, id) {
  try {
    const row = await rowById(id)
    if (!row) return json(res, 404, { error: `no runnable called ${id}` })

    const { startRow } = await import('./children.js')
    const out = startRow(row, { root: global.projectRoot, fliRoot: global.fliRoot })
    if (!out.ok) return json(res, out.status, { error: out.error })

    json(res, 200, { ok: true, id, pid: out.pid })
  } catch (err) {
    json(res, 500, { error: err.message })
  }
}

async function handleStop(req, res, id) {
  try {
    const row = await rowById(id)
    const { stopRow } = await import('./children.js')
    const out = stopRow(id, { name: row?.name ?? id })
    if (!out.ok) return json(res, out.status, { error: out.error })
    json(res, 200, { ok: true, id })
  } catch (err) {
    json(res, 500, { error: err.message })
  }
}

async function handleOutput(req, res, id) {
  try {
    const { outputOf, childOf } = await import('./children.js')
    json(res, 200, { id, lines: outputOf(id), child: childOf(id) })
  } catch (err) {
    json(res, 500, { error: err.message })
  }
}

// ─── POST /api/ports/clean ───────────────────────────────────────────────────
async function handlePortsClean(req, res) {
  try {
    const body = await new Promise((resolve, reject) => {
      let d = ''; req.on('data', c => d += c)
      req.on('end', () => { try { resolve(JSON.parse(d)) } catch { reject(new Error('Invalid JSON')) } })
    })
    const { releaseSession } = await import('./ports.js')
    releaseSession(body.name)
    json(res, 200, { ok: true })
  } catch (err) {
    json(res, 500, { error: err.message })
  }
}

// ─── GET /api/ports/schema ────────────────────────────────────────────────────
async function handlePortsSchema(req, res) {
  try {
    const { ENV, CAT, GLOBAL } = await import('./ports.js')
    json(res, 200, { ENV, CAT, GLOBAL })
  } catch (err) {
    json(res, 500, { error: err.message })
  }
}

// ─── GET /api/env ─────────────────────────────────────────────────────────────
function handleEnv(req, res) {
  const envPath = resolve(homedir(), '.config', 'fli', '.env')
  let content = ''
  try { content = readFileSync(envPath, 'utf8') }
  catch { content = '# FLI global environment\n# Add env vars here that apply across all projects\n' }
  json(res, 200, { path: envPath, content })
}

// ─── POST /api/env ────────────────────────────────────────────────────────────
async function handleEnvSave(req, res) {
  try {
    const body = await new Promise((resolve, reject) => {
      let data = ''
      req.on('data', chunk => data += chunk)
      req.on('end', () => { try { resolve(JSON.parse(data)) } catch { reject(new Error('Invalid JSON')) } })
    })
    const { content } = body
    const envPath = resolve(homedir(), '.config', 'fli', '.env')
    mkdirSync(resolve(homedir(), '.config', 'fli'), { recursive: true })
    writeFileSync(envPath, content, 'utf8')
    json(res, 200, { ok: true, path: envPath })
  } catch (err) {
    json(res, 500, { error: err.message })
  }
}

// ─── GET / ───────────────────────────────────────────────────────────────────

function handleStatic(res) {
  try {
    const html = readFileSync(resolve(__dir, '../web/index.html'), 'utf8')
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(html)
  } catch {
    res.writeHead(404)
    res.end('Web GUI not found — make sure web/index.html exists')
  }
}

// ─── GET /fli.css ────────────────────────────────────────────────────────────
//
// The GUI is written in `@frontierjs/css` (Invariant 13) and gets it from here
// rather than from a CDN, so it renders with no network and is styled by the
// copy this `fli` was installed with rather than by whatever the registry
// answers today.
//
// Built once per process: the source cannot change under a running server
// without the install changing, and the build walks 48 files.
//
// The redirect is the last resort, for an install whose `@frontierjs/css` is
// missing entirely. It is a redirect rather than an inline link so the page
// carries ONE href either way — a GUI that styles itself from two places is
// one where a theme works on one machine and not the next.

let _stylesheet

function handleStylesheet(res) {
  if (_stylesheet === undefined) _stylesheet = ownStyleBundle()

  if (!_stylesheet) {
    res.writeHead(302, { Location: CDN_STYLESHEET })
    res.end()
    return
  }

  res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' })
  res.end(_stylesheet)
}

// ─── GET /glow.js ────────────────────────────────────────────────────────────
//
// A 404 here is not fatal and must not be: the GUI shows a command's source
// unhighlighted rather than not at all.

let _glow

function handleGlow(res) {
  if (_glow === undefined) _glow = glowSource()

  if (!_glow) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('// @frontierjs/toolbelt not resolvable — code blocks render unhighlighted')
    return
  }

  res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' })
  res.end(_glow)
}

// ─── GET /api/commands ────────────────────────────────────────────────────────

function handleList(req, res) {
  try {
    const registry = getRegistry()
    const commands = uniqueCommands(registry)
    json(res, 200, commands)
  } catch (err) {
    json(res, 500, { error: err.message })
  }
}

// ─── GET /api/commands/:name ──────────────────────────────────────────────────

async function handleMeta(req, res, name) {
  try {
    const registry = getRegistry()
    const entry = registry.get(name)
    if (!entry) {
      return json(res, 404, { error: `Command "${name}" not found` })
    }

    // Decompose the .md file into ordered prose+code segments for the GUI.
    // The runtime ignores this — segments are purely for presentation.
    const raw = readFileSync(entry.filePath, 'utf8')
    const { script, segments } = extractSegments(raw)

    const cmdNs  = entry.meta.title?.split(':')?.[0]
    const mod    = cmdNs ? getModule(cmdNs) : null

    // ── Discover _steps* folders alongside the command file ──────────────────────
    const cmdDir  = dirname(entry.filePath)
    const allDirs = existsSync(cmdDir) ? readdirSync(cmdDir, { withFileTypes: true }) : []
    const stepFolders = allDirs
      .filter(d => d.isDirectory() && /^_steps/.test(d.name))
      .map(d => {
        const folderPath = resolve(cmdDir, d.name)
        const steps = existsSync(folderPath)
          ? readdirSync(folderPath)
              .filter(f => f.endsWith('.md') && /^\d/.test(f))
              .sort()
              .map(f => {
                const stepRaw  = readFileSync(resolve(folderPath, f), 'utf8')
                const stepBody = stripFrontmatter(stepRaw)
                const skipMatch = stepRaw.match(/^skip:\s*(.+)$/m)
                const optMatch  = stepRaw.match(/^optional:\s*(true|false)/m)
                const descMatch = stepRaw.match(/^description:\s*(.+)$/m)
                return {
                  file:        f,
                  name:        basename(f, '.md'),
                  description: descMatch ? descMatch[1].trim() : null,
                  skip:        skipMatch ? skipMatch[1].trim() : null,
                  optional:    optMatch  ? optMatch[1] === 'true' : false,
                }
              })
          : []
        return { folder: d.name, steps, isDefault: d.name === '_steps' }
      })

    // Does ANY js segment set context.config.stepsDir dynamically?
    const dynamicSteps = segments
      .filter(s => s.type === 'code' && s.lang === 'js')
      .some(s => s.content.includes('context.config.stepsDir')
              || s.content.includes('config.stepsDir'))

    // Module's own segments (for namespace docs in the GUI)
    const moduleSource = mod
      ? extractSegments(readFileSync(mod.filePath, 'utf8'))
      : null

    json(res, 200, {
      ...entry.meta,
      _source: {
        script,
        segments,
      },
      _module: mod ? {
        description: mod.meta?.description || null,
        requires:    mod.meta?.requires    || [],
        script:      moduleSource?.script   || null,
        segments:    moduleSource?.segments || [],
      } : null,
      _steps: stepFolders.length ? {
        folders:      stepFolders,
        dynamic:      dynamicSteps,
        folderCount:  stepFolders.length,
        totalSteps:   stepFolders.reduce((n, f) => n + f.steps.length, 0),
      } : null,
    })
  } catch (err) {
    json(res, 500, { error: err.message })
  }
}

// ─── POST /api/run/:name ──────────────────────────────────────────────────────
// Body: { args: [...], flags: {...} }
// Response: SSE stream

async function handleRun(req, res, name) {
  // Parse request body
  let body
  try {
    body = await readBody(req)
  } catch {
    return json(res, 400, { error: 'Invalid JSON body' })
  }

  const { args = [], flags = {} } = body

  // Look up command
  const registry = getRegistry()
  const entry = registry.get(name)
  if (!entry) {
    return json(res, 404, { error: `Command "${name}" not found` })
  }

  // Start SSE stream
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
  })

  // emit() sends one SSE event to the client
  const emit = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  try {
    const command = await Command({ file: entry.filePath, arg: args, flag: flags, emit })
    await command()
    emit({ type: 'done' })
  } catch (err) {
    emit({ type: 'error', text: err.message })
  } finally {
    res.end()
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body, null, 2))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => { data += chunk })
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}) }
      catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

// ─── Start ────────────────────────────────────────────────────────────────────

export function startServer() {
  const server = createServer(route)
  server.listen(PORT, () => {
    console.log(`FLI server running on http://localhost:${PORT}`)
    console.log(`  GET  http://localhost:${PORT}/api/commands`)
    console.log(`  POST http://localhost:${PORT}/api/run/:name`)
  })

  // Anything the page started dies with this process. Registered here rather
  // than at import in `children.js`, because a module that installs a process
  // listener the moment it is required is one a test cannot import without
  // inheriting it. `exit` cannot await, which is why the kill is a signal.
  const reap = async () => {
    try { (await import('./children.js')).killAll() } catch {}
  }
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => { reap().finally(() => process.exit(0)) })
  }
  server.once('close', reap)

  return server
}
