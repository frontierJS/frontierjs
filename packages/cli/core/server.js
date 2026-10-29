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
//   GET  /api/proves          → DRIVES.md's proof table against `git diff`
//   GET  /api/status          → the working tree grouped — `core/git-status.js`
//   GET  /api/health/:id      → what the thing on that port says about itself
//   GET  /api/check           → the architecture rules over this project's apps
//   GET  /api/doctor          → can this machine run fli
//   GET  /api/decisions       → the open questions the registers hold
//   GET  /api/next            → the open register ranked — `core/next.js`
//   POST /api/decide          → rule on one — `core/decide.js`, the command's own writer
//   GET  /api/ci              → the CI run log — `core/ci-log.js`
//   POST /api/ci/run · POST /api/ci/stop
//   POST /api/ci/fix          → SSE stream, the remedy a failure names — `fix` in the run log
//   GET  /api/release/steps   → the release in order — `core/release-view.js`
//   POST /api/release/step    → SSE stream, one step as `fli` in its directory
//   POST /api/release/step/stop
//   GET  /api/publish         → the workspace's packages and the publish steps — `core/publish-view.js`
//   POST /api/publish/registry → what npm holds, `ws:npm --json` — a press, it asks the registry
//   POST /api/start/:id · POST /api/stop/:id · GET /api/output/:id
//   GET  /api/map/apps        → the apps here — `core/map-view.js`
//   GET  /api/map?app=<dir>   → that app's `project:map --json`
//   POST /api/map/secret      → one secret into its `.env` — `core/env-health.js`
//   GET  /api/dns/accounts · /api/dns/zones?profile=&account= · /api/dns/records?profile=&zone=
//                             → `:dns`, `core/cloudflare.js` over `cf`
//   POST /api/dns/login       → SSE stream, `cf auth login`'s device code; its link opened here
//   POST /api/dns/records · PUT|DELETE /api/dns/records/<id> → one write; a Basecamp record is a 409 first
//   GET  /api/live/stream     → devtools' socket, a frame a line — `core/live-view.js`
//   GET  /api/live/health · /api/live/metrics · /api/live/jobs · /api/live/call
//   GET  /api/live/data · /api/live/data/<Model>?as=&tenant= → rows as somebody (`:data`)
//   POST /api/live/jobs/<id>/retry · …/cancel · /api/live/jobs/run/<name>
//   POST /api/live/call       → one method as somebody, inside the app (`:call`)
//   GET  /api/live/ask?as=&tenant= → the tools `:ask`'s agent is offered at that standing
//   POST /api/live/ask        → one question to an agent over the app's MCP, as somebody (`:ask`)
//
// And the console, the same reads drawn by `.mesa` screens — `core/console.js`:
//   GET  /console/            → the page; its modules under /console/ and /@fjs/
//
// SSE event shapes sent to client:
//   data: {"type":"output","text":"Hello, World!\n"}
//   data: {"type":"log","level":"success","text":"Done"}
//   data: {"type":"done"}
//   data: {"type":"error","text":"arg [name] is required!"}
// ─────────────────────────────────────────────────────────────────────────────

import { createServer }  from 'http'
import { requiresOf }                    from './requires.js'
import { globalEnvPath, GLOBAL_ENV_HEADER } from './global-env.js'
import { gitOut }        from './git.js'
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { basename } from 'path'
import { resolve, dirname, relative } from 'path'
import { rel } from './fs.js'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))
import { buildRegistry, uniqueCommands, getModule } from './registry.js'
import { Command } from './runtime.js'
import { extractSegments, splitFrontmatter } from './compiler.js'

import { GLOBAL } from './ports.js'
import { ownStyleBundle, glowSource, CDN_STYLESHEET } from './assets.js'
import { isConsolePath, handleConsole } from './console.js'
const PORT = parseInt(process.env.FLI_PORT, 10) || GLOBAL.gui

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

  // GET /api/page/:id — a committed page, served so the GUI can open it
  const pageMatch = path.match(/^\/api\/page\/(.+)$/)
  if (req.method === 'GET' && pageMatch) {
    return handlePage(req, res, decodeURIComponent(pageMatch[1]))
  }

  // GET /console/ — the `.mesa` screens, beside the page below until they replace it
  if (req.method === 'GET' && isConsolePath(path)) {
    return handleConsole(res, path)
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

  // GET /api/map/apps · GET /api/map?app= · POST /api/map/secret — the `:map` pane
  if (req.method === 'GET' && path === '/api/map/apps') {
    return handleMapApps(req, res)
  }
  if (req.method === 'GET' && path === '/api/map') {
    return handleMap(req, res, url.searchParams.get('app') ?? '.')
  }
  if (req.method === 'POST' && path === '/api/map/secret') {
    return handleMapSecret(req, res)
  }

  // GET /api/dns/… · POST /api/dns/login — the `:dns` pane
  if (req.method === 'POST' && path === '/api/dns/login') {
    return handleDnsLogin(req, res)
  }
  const dnsMatch = path.match(/^\/api\/dns\/(accounts|zones|records)$/)
  if (req.method === 'GET' && dnsMatch) {
    return handleDns(res, dnsMatch[1], url.searchParams)
  }
  const dnsWrite = path.match(/^\/api\/dns\/records(?:\/([^/]+))?$/)
  if (dnsWrite && (req.method === 'POST' ? !dnsWrite[1] : (req.method === 'PUT' || req.method === 'DELETE') && dnsWrite[1])) {
    return handleDnsWrite(req, res, dnsWrite[1] && decodeURIComponent(dnsWrite[1]))
  }

  // GET /api/live/… · POST /api/live/… — `:live`, `:call` and `:data`, devtools carried
  if (req.method === 'POST' && path === '/api/live/ask') {
    return handleLiveAsk(req, res)
  }
  if (req.method === 'GET' && path === '/api/live/stream') {
    return import('./live-view.js').then(m => m.streamLive(res))
  }
  const liveMatch = path.match(/^\/api\/live\/(.+)$/)
  if (req.method === 'GET' && liveMatch) {
    return import('./live-view.js').then(m => m.readLive(liveMatch[1], url.searchParams)).then(out => json(res, out.status, out.body))
  }
  if (req.method === 'POST' && liveMatch) {
    return handleLiveAct(req, res, liveMatch[1])
  }

  // GET /api/proves — which of them prove what you have changed
  if (req.method === 'GET' && path === '/api/proves') {
    return handleProves(req, res)
  }

  // GET /api/status — what you have changed, grouped by place and by role
  if (req.method === 'GET' && path === '/api/status') {
    return handleStatus(req, res)
  }

  // GET /api/check — the architecture rules over this project's own apps
  if (req.method === 'GET' && path === '/api/check') {
    return handleCheck(req, res)
  }

  // GET /api/doctor — can this machine run fli
  if (req.method === 'GET' && path === '/api/doctor') {
    return handleDoctor(req, res)
  }

  // GET /api/next — the open register ranked, each row with its terms
  if (req.method === 'GET' && path === '/api/next') {
    return handleNext(req, res)
  }

  // GET /api/decisions — what is waiting on the owner
  if (req.method === 'GET' && path === '/api/decisions') {
    return handleDecisions(req, res)
  }

  // POST /api/decide — answer one, through the same writer `fli register:decide` uses
  if (req.method === 'POST' && path === '/api/decide') {
    return handleDecide(req, res)
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

  // The release in order, and one step of it run. POST for the same reason as
  // the target: most steps reach a machine or write a file.
  if (req.method === 'GET' && path === '/api/release/steps') {
    return import('./release-view.js').then(m => json(res, 200, m.describeSteps()))
  }
  if (req.method === 'POST' && path === '/api/release/step') {
    return handleReleaseStep(req, res)
  }
  if (req.method === 'POST' && path === '/api/release/step/stop') {
    return handleReleaseStepStop(req, res)
  }
  if (req.method === 'GET' && path === '/api/publish') {
    return handlePublish(req, res)
  }
  if (req.method === 'POST' && path === '/api/publish/registry') {
    return handlePublishRegistry(req, res)
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

  // GET /api/ci — the CI run log: the run going now, history, each suite's latest
  if (req.method === 'GET' && path === '/api/ci') {
    return handleCi(req, res, url)
  }

  // POST /api/ci/run · POST /api/ci/stop — start `scripts/ci.mjs`, or stop it
  if (req.method === 'POST' && path === '/api/ci/run') {
    return handleCiRun(req, res)
  }
  if (req.method === 'POST' && path === '/api/ci/fix') {
    return handleCiFix(req, res)
  }
  if (req.method === 'POST' && path === '/api/ci/stop') {
    return handleCiStop(req, res)
  }

  // GET /api/ask-claude — the defaults the page shows and lets be edited
  // POST /api/ask-claude · POST /api/ask-claude/stop — the output panel handed
  // to Claude Code, the reply streamed back; or stop the one asking
  if (req.method === 'GET' && path === '/api/ask-claude') {
    return handleAskClaudeDefaults(req, res)
  }
  if (req.method === 'POST' && path === '/api/ask-claude') {
    return handleAskClaude(req, res)
  }
  if (req.method === 'POST' && path === '/api/ask-claude/stop') {
    return handleAskClaudeStop(req, res)
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

// ─── the decisions ────────────────────────────────────────────────────────────
//
// The read and the write are `core/decisions.js` and `core/decide.js`, the same
// two modules the commands call, so the page and the terminal cannot disagree
// about what is open or about what a pick writes.

// No parameter: the page shows the whole ranking's head, and a package filter
// is a thing a person types at a terminal.
async function handleNext(req, res) {
  try {
    const { rankNext } = await import('./next.js')
    const out = rankNext(global.projectRoot)
    json(res, 200, { ready: out.ready.slice(0, 8), readyCount: out.ready.length, blocked: out.blocked, decide: out.decide })
  } catch (err) {
    json(res, 500, { error: err.message })
  }
}

async function handleDecisions(req, res) {
  try {
    const { openDecisions, rulingSections } = await import('./decisions.js')
    const root = global.projectRoot
    json(res, 200, { ...openDecisions(root), sections: rulingSections(root) })
  } catch (err) {
    json(res, 500, { error: err.message })
  }
}

// This writes two register files.
async function handleDecide(req, res) {
  const foreign = foreignOrigin(req)
  if (foreign) return json(res, 403, { ok: false, reason: `a decision is not taken from ${foreign}` })

  let body
  try { body = await readBody(req) } catch { return json(res, 400, { ok: false, reason: 'Invalid JSON body' }) }

  try {
    const { decide } = await import('./decide.js')
    const out = decide({
      root:    global.projectRoot,
      id:      String(body?.id ?? ''),
      pick:    String(body?.pick ?? ''),
      why:     String(body?.why ?? ''),
      section: String(body?.section ?? ''),
    })
    json(res, out.ok ? 200 : 400, out)
  } catch (err) {
    json(res, 500, { ok: false, reason: err.message })
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

// ─── GET /api/page/:id ───────────────────────────────────────────────────────
//
// `fli ws:atlas` writes two pages describing this workspace and the GUI could
// press the button that regenerates them — a snapshot generator is a runnable
// row — while having no way to OPEN one. A `file://` link from an http page is
// refused by every browser, so the server that already knows the project root
// serves them.
//
// **The id is looked up, never joined.** What arrives is compared against the
// rows `runnables()` computed; a row with no `page` is a 404
// with the same wording as one that does not exist. So no caller-supplied text
// reaches a path, which is Invariant 8's rule one realm over, and `..` is not a
// case to handle because there is nothing for it to traverse.

async function handlePage(req, res, id) {
  const row = await rowById(id)

  if (!row?.page) {
    json(res, 404, { error: `no page ${id}` })
    return
  }

  const { readPage } = await import('./runnables.js')
  const body = readPage(global.projectRoot, row)
  if (body == null) {
    // Generated and gitignored, or generated and never run. The generator is on
    // the row that linked here, so the answer says which button to press.
    json(res, 404, { error: `${row.page} is not written — run \`${row.start ?? 'its generator'}\`` })
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(body)
}

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

// ─── /api/map ────────────────────────────────────────────────────────────────
//
// The `:map` pane's reads, `core/map-view.js`. The secret is the one write: a
// generated value or an empty placeholder into that app's `.env`.

async function handleMapApps(req, res) {
  try {
    const { mapApps } = await import('./map-view.js')
    json(res, 200, { apps: mapApps(global.projectRoot) })
  } catch (err) {
    json(res, 500, { error: err.message })
  }
}

async function handleMap(req, res, app) {
  const { readMap } = await import('./map-view.js')
  const out = await readMap(global.projectRoot, app, { fliRoot: global.fliRoot })
  json(res, out.status, out.body)
}

async function handleMapSecret(req, res) {
  const foreign = foreignOrigin(req)
  if (foreign) return json(res, 403, { error: `a secret is not written from ${foreign}` })
  let body
  try { body = await readBody(req) } catch { return json(res, 400, { error: 'Invalid JSON body' }) }
  const { fillMapSecret } = await import('./map-view.js')
  const out = fillMapSecret(global.projectRoot, String(body?.app ?? '.'), body?.key)
  json(res, out.status, out.body)
}

// ─── /api/dns ────────────────────────────────────────────────────────────────
//
// The `:dns` pane's reads, each the module's answer as it is. A refusal is
// `cf`'s own words at 502, since the failure is upstream of this server.

async function handleDns(res, kind, params) {
  const cloudflare = await import('./cloudflare.js')
  try {
    if (kind === 'accounts') return json(res, 200, { accounts: await cloudflare.reachable() })
    const profile = cloudflare.profileFor(params.get('profile') || undefined)
    if (kind === 'zones') return json(res, 200, { zones: await cloudflare.zones(profile, params.get('account') || undefined) })
    const zone = params.get('zone')
    if (!zone) return json(res, 400, { error: 'zone is required' })
    json(res, 200, { records: await cloudflare.records(profile, zone) })
  } catch (err) {
    json(res, err instanceof cloudflare.CloudflareError ? 502 : 500, { error: err.message })
  }
}

// A write to a record Basecamp marked goes ahead, but only once the person has
// seen that the sync will put it back (`FJS-D1471`): without `confirm` it is a
// 409 carrying the warning, and the pane sends again with `confirm: true`. The
// target is read from Cloudflare first, because the pane's table is one read
// old and the sync may have marked the record since. A comment that writes the
// mark hands the record to the sync, so it warns the same way.
async function handleDnsWrite(req, res, id) {
  const foreign = foreignOrigin(req)
  if (foreign) return json(res, 403, { error: `a DNS record is not written from ${foreign}` })
  let body
  try { body = await readBody(req) } catch { return json(res, 400, { error: 'Invalid JSON body' }) }
  const { zone, confirm } = body ?? {}
  const sent = req.method === 'POST' ? body?.record : req.method === 'PUT' ? body?.changes : {}
  if (!zone) return json(res, 400, { error: 'zone is required' })
  if (!sent || typeof sent !== 'object') return json(res, 400, { error: `${req.method === 'POST' ? 'record' : 'changes'} is required` })
  const cloudflare = await import('./cloudflare.js')
  try {
    const profile = cloudflare.profileFor(body.profile || undefined)
    if (!confirm) {
      const target = id ? await cloudflare.record(profile, zone, id) : null
      const warning = target && cloudflare.marked(target.comment)
        ? `${target.name} ${target.type} is Basecamp's (${target.comment}) — domain:dns puts it back on its next sync`
        : cloudflare.marked(sent.comment)
        ? `the comment ${sent.comment} hands this record to Basecamp — domain:dns may change or remove it on its next sync`
        : null
      if (warning) return json(res, 409, { warning })
    }
    if (req.method === 'POST') return json(res, 201, { record: await cloudflare.createRecord(profile, zone, sent) })
    if (req.method === 'PUT') return json(res, 200, { record: await cloudflare.updateRecord(profile, zone, id, sent) })
    await cloudflare.deleteRecord(profile, zone, id)
    json(res, 200, { deleted: id })
  } catch (err) {
    json(res, err instanceof cloudflare.CloudflareError ? 502 : 500, { error: err.message })
  }
}

// One sign-in at a time: `cf` keeps one login per profile, and two device
// codes leave the person guessing which one to type. A second stream while one
// waits joins it — the terminal and a browser on one console show one code —
// and the last stream closing is the person leaving, which stops the wait.
let signingIn = null
async function handleDnsLogin(req, res) {
  const foreign = foreignOrigin(req)
  if (foreign) return json(res, 403, { error: `cf auth login is not started from ${foreign}` })
  const cloudflare = await import('./cloudflare.js')
  if (!signingIn) {
    const { openUrl } = await import('./open-url.js')
    const flow = { said: [], watching: new Set() }
    const send = (event) => {
      flow.said.push(event)
      for (const w of flow.watching) if (!w.destroyed) w.write(`data: ${JSON.stringify(event)}\n\n`)
    }
    try {
      flow.cf = cloudflare.login({ onEvent: (event) => {
        if (event.type === 'link') openUrl(event.url)
        send(event)
      } })
    } catch (err) {
      return json(res, err instanceof cloudflare.CloudflareError ? 502 : 500, { error: err.message })
    }
    signingIn = flow
    flow.cf.done.then((out) => {
      signingIn = null
      send({ type: 'done', ...out })
      for (const w of flow.watching) w.end()
    })
  }
  const flow = signingIn
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' })
  for (const event of flow.said) res.write(`data: ${JSON.stringify(event)}\n\n`)
  flow.watching.add(res)
  res.on('close', () => {
    flow.watching.delete(res)
    if (!flow.watching.size && signingIn === flow) flow.cf.stop()
  })
}

// ─── /api/live ───────────────────────────────────────────────────────────────
//
// An act on the app (a call as somebody, or the queue) is a POST from this
// origin only: devtools refuses a foreign one itself, and the relay must not
// be the way round that.

async function handleLiveAct(req, res, rest) {
  const foreign = foreignOrigin(req)
  if (foreign) return json(res, 403, { error: `the app is not acted on from ${foreign}` })
  let body
  try { body = await readBody(req) } catch { return json(res, 400, { error: 'Invalid JSON body' }) }
  const { actLive } = await import('./live-view.js')
  const out = await actLive(rest, body)
  json(res, out.status, out.body)
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

// The working tree grouped the way the terminal groups it. The page and `fli
// gs` read one model out of `core/git-status.js`, because two renderers of one
// question is how the GUI comes to disagree with the terminal about what is
// dirty.
async function handleStatus(req, res) {
  try {
    const root = global.projectRoot
    const git = argv => gitOut(root, argv) ?? ''

    const { buildStatus } = await import('./git-status.js')
    const { usedByIndex, blastReader } = await import('./blast.js')
    const model = buildStatus({
      porcelain: git(['status', '--porcelain', '-z']),
      unstaged:  git(['diff', '--no-color', '--numstat']),
      staged:    git(['diff', '--no-color', '--numstat', '--cached']),
      branch:    git(['rev-parse', '--abbrev-ref', 'HEAD']).trim() || null,
      blastOf:   blastReader(usedByIndex(root)),
    })

    json(res, 200, { at: new Date().toISOString(), ...model })
  } catch (err) {
    json(res, 500, { error: err.message })
  }
}

async function handleProves(req, res) {
  try {
    const root = global.projectRoot
    const { provesFor, changedTree } = await import('./proofs.js')
    const { runnables }              = await import('./runnables.js')

    const { files, diff } = changedTree(root)
    if (!files.length) return json(res, 200, { at: new Date().toISOString(), files: [], rows: [] })

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
// more than the findings are worth. Requests that overlap share one run.

// One scope on its own thread. `runChecks` is synchronous and the repo scope
// alone is several seconds: run in this thread the scopes queue behind each
// other and freeze the state poll, and run one after another on workers they
// still take their sum. The grade is read there too (the app's own ratchet,
// which `fli check` exits on), so the panel and the command cannot disagree
// about whether an app carrying declared debt is failing.
let inFlightCheck = null

function checkScope(s) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./check-worker.js', import.meta.url))
    worker.onmessage = ({ data }) => {
      worker.terminate()
      if (data.error) reject(new Error(`${s.label}: ${data.error}`))
      else resolve(data)
    }
    worker.onerror = (e) => { worker.terminate(); reject(new Error(`${s.label}: ${e.message}`)) }
    worker.postMessage({ root: s.root, scope: s.scope })
  })
}

async function handleCheck(req, res) {
  try {
    const root = global.projectRoot
    const { findApps, BASELINE_FILE } = await import('./checks.js')
    const { findWorkspaceRoot }       = await import('./utils.js')
    const { relative, resolve }       = await import('path')

    // Per app, then the workspace's own rules — the same two passes the
    // `structure` CI phase makes, so a rule loosened for one is loosened for
    // both. An app is a directory with a seed, which is this framework's own
    // definition and already what every rule is graded against. The second
    // pass is a workspace's only: run over a lone app it grades rules
    // `fli check` there never runs, and the panel reds a green app.
    const scopes = findApps(root).map(dir => ({ label: relative(root, dir) || '.', root: dir, scope: 'app' }))
    if (findWorkspaceRoot(root) === resolve(root)) scopes.push({ label: 'packages', root, scope: 'repo' })

    // One run answers every request that arrives while it is going: the panel
    // and the page's own reload each ask for the whole set, and a second full
    // run queued behind the first doubles the wait a drive already times out on.
    inFlightCheck ??= Promise.all(scopes.map(checkScope))
      .then(ran => ({ at: new Date().toISOString(), scopes, ran }))
      .finally(() => { inFlightCheck = null })
    const { at, scopes: asked, ran } = await inFlightCheck

    const out = []
    for (const [i, s] of asked.entries()) {
      const { result: r, grade } = ran[i]

      out.push({
        label:    s.label,
        dir:      s.scope === 'repo' ? '.' : s.label,
        ran:      r.ran.length,
        skipped:  r.skipped.length,
        findings: r.findings.map(f => ({
          rule: f.rule, severity: f.severity, line: f.line ?? null,
          file: f.file ? relative(root, f.file) : null,
          message: f.message,
          // Declared debt is still printed — it is the count that is capped,
          // never the finding — so each one says which side of the line it is on.
          within: grade ? !grade.regressions.some(g => g.rule === f.rule) : false,
        })),
        // Absent means no baseline: nothing is declared, so nothing is allowed.
        baseline: grade
          ? { file: BASELINE_FILE, ok: grade.ok, regressions: grade.regressions }
          : null,
        // What `fli check` would exit. A scope with a baseline passes when it is
        // within it; one without passes when it has no errors.
        ok: grade ? grade.ok : r.findings.every(f => f.severity !== 'error'),
      })
    }

    json(res, 200, {
      at,
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
// **Fetched by this server and not by the page.** The page is on 5500 and the
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

// ─── the CI run log ──────────────────────────────────────────────────────────
//
// `core/ci-log.js` is the one reader of what `scripts/ci.mjs` writes, and a run
// started here is that same script with flags, so the page and the terminal
// cannot disagree about what ran.

async function handleCi(req, res, url) {
  try {
    const { ciState } = await import('./ci-log.js')
    json(res, 200, ciState(global.projectRoot, { runId: url.searchParams.get('run') }))
  } catch (err) {
    json(res, 500, { error: err.message })
  }
}

async function handleCiRun(req, res) {
  const foreign = foreignOrigin(req)
  if (foreign) return json(res, 403, { error: `a CI run is not started from ${foreign}` })
  let body
  try { body = await readBody(req) } catch { return json(res, 400, { error: 'Invalid JSON body' }) }
  try {
    const { startCiRun } = await import('./ci-log.js')
    const out = await startCiRun(global.projectRoot, {
      tier:   body?.tier ?? null,
      phases: Array.isArray(body?.phases) ? body.phases : [],
      only:   body?.only ?? null,
    })
    json(res, out.ok ? 200 : out.status, out.ok ? out : { error: out.error })
  } catch (err) {
    json(res, 500, { error: err.message })
  }
}

// A failure's `fix` arrives as a KIND and the argv is built here, so the run
// log — a file anything on this machine can write — never names a command.
// The snapshot path goes to `fli` as one argv element, and the command refuses
// one discovery did not find.
const CI_FIXES = {
  snapshot: (fix) => typeof fix.file === 'string' && fix.file
    ? ['test:snapshots', '--fix', '--only', fix.file]
    : null,
}
let ciFix = null

async function handleCiFix(req, res) {
  const foreign = foreignOrigin(req)
  if (foreign) return json(res, 403, { error: `a CI fix is not run from ${foreign}` })
  let body
  try { body = await readBody(req) } catch { return json(res, 400, { error: 'Invalid JSON body' }) }
  const make = Object.hasOwn(CI_FIXES, body?.kind) ? CI_FIXES[body.kind] : null
  const argv = make?.(body)
  if (!argv) return json(res, 400, { error: `no fix of kind ${JSON.stringify(String(body?.kind).slice(0, 40))}` })
  if (ciFix) return json(res, 409, { error: `${ciFix} is still running` })

  const { spawnStep } = await import('./release-view.js')
  const emit = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`)
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' })
  ciFix = `fli ${argv.join(' ')}`
  emit({ type: 'log', level: 'info', text: `$ ${ciFix}` })
  const { done } = spawnStep({ fliRoot: global.fliRoot, cwd: global.projectRoot, argv, onLine: text => emit({ type: 'output', text }) })
  const code = await done
  ciFix = null
  emit({ type: 'done', code })
  res.end()
}

async function handleCiStop(req, res) {
  const foreign = foreignOrigin(req)
  if (foreign) return json(res, 403, { error: `a CI run is not stopped from ${foreign}` })
  try {
    const { stopCiRun } = await import('./ci-log.js')
    const out = stopCiRun(global.projectRoot)
    json(res, out.ok ? 200 : out.status, out.ok ? out : { error: out.error })
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
    releaseSession(body.root)
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
  const envPath = globalEnvPath()
  let content = ''
  try { content = readFileSync(envPath, 'utf8') }
  catch { content = GLOBAL_ENV_HEADER }
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
    const envPath = globalEnvPath()
    mkdirSync(dirname(envPath), { recursive: true })
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
                const stepPath = resolve(folderPath, f)
                const { meta } = splitFrontmatter(readFileSync(stepPath, 'utf8'), stepPath)
                return {
                  file:        f,
                  name:        basename(f, '.md'),
                  description: meta.description ?? null,
                  skip:        meta.skip ?? null,
                  optional:    meta.optional === true,
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
        requires:    requiresOf(mod.meta).map(r => r.key),
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

// ─── POST /api/release/step ──────────────────────────────────────────────────
//
// One step at a time, whoever asked: two deploys racing for one journal is the
// thing the journal's own lock refuses, and refusing it here says so sooner.
// The step and target are checked against `RELEASE_STEPS` and `TARGETS` by key
// in `runReleaseStep`; nothing from the body reaches argv another way.

let releaseStep = null

async function handleReleaseStep(req, res) {
  const foreign = foreignOrigin(req)
  if (foreign) return json(res, 403, { error: `a release step is not run from ${foreign}` })
  let body
  try { body = await readBody(req) } catch { return json(res, 400, { error: 'Invalid JSON body' }) }
  if (releaseStep) return json(res, 409, { error: `${releaseStep.id} is still running` })

  const emit = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`)
  const common = {
    root:     global.projectRoot,
    fliRoot:  global.fliRoot,
    id:       String(body?.step ?? ''),
    fix:      body?.fix === true,
    approved: body?.approved === true,
    onLine:   (text) => emit({ type: 'output', text }),
  }
  // Two flows, one slot: a deploy and a publish both end in a push, and one
  // at a time is what keeps two of them from racing for the same commit.
  let out
  if (body?.flow === 'publish') {
    const { runPublishStep } = await import('./publish-view.js')
    out = runPublishStep({ ...common, opts: body?.opts ?? {} })
  } else {
    const { runReleaseStep } = await import('./release-view.js')
    out = runReleaseStep({ ...common, app: body?.app ? String(body.app) : null, target: String(body?.target ?? 'default') })
  }
  if (out.error) return json(res, 400, { error: out.error })

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' })
  releaseStep = { id: String(body.step), child: out.child }
  emit({ type: 'log', level: 'info', text: `$ cd ${out.cwd} && ${out.display ?? `fli ${out.argv.join(' ')}`}` })
  const code = await out.done
  releaseStep = null
  emit({ type: 'done', code })
  res.end()
}

// ─── GET /api/publish · POST /api/publish/registry ───────────────────────────
//
// The local half loads with the page — the members and `ws:changed`, which is
// git. What npm and the release host hold is a request to somebody else's
// server and waits for a press, the same split as the release target.

async function handlePublish(req, res) {
  try {
    const { publishLocal, describePublish } = await import('./publish-view.js')
    json(res, 200, { ...publishLocal({ root: global.projectRoot, fliRoot: global.fliRoot }), ...describePublish() })
  } catch (err) {
    json(res, 500, { error: err.message })
  }
}

async function handlePublishRegistry(req, res) {
  let body
  try { body = await readBody(req) } catch { return json(res, 400, { error: 'Invalid JSON body' }) }
  try {
    const { publishRegistry } = await import('./publish-view.js')
    const out = await publishRegistry({ root: global.projectRoot, fliRoot: global.fliRoot, tag: String(body?.tag ?? 'latest'), to: body?.to })
    json(res, out.ok ? 200 : 400, out)
  } catch (err) {
    json(res, 500, { error: err.message })
  }
}

function handleReleaseStepStop(req, res) {
  const foreign = foreignOrigin(req)
  if (foreign) return json(res, 403, { error: `a release step is not stopped from ${foreign}` })
  if (!releaseStep) return json(res, 409, { error: 'no step is running' })
  // The group, not the pid: `fli` is a launcher, and a drive's server or a
  // deploy's ssh outlives a signal to the wrapper alone.
  try { process.kill(-releaseStep.child.pid, 'SIGTERM') } catch {}
  json(res, 200, { ok: true, step: releaseStep.id })
}

// ─── POST /api/ask-claude ────────────────────────────────────────────────────
//
// Body: { question, output, context: {label: value}, rules, session, effort }. One at a time:
// a second press while one answers would be two agents reading one tree on one
// account with nothing on the page saying which reply is which.

let asking = null

async function handleAskClaudeDefaults(req, res) {
  const { ASK_BASH, ASK_BUDGET_USD, ASK_DEFAULT_QUESTION, ASK_EFFORT, ASK_RULES, ASK_TOOLS, EFFORTS } = await import('./ask-claude.js')
  json(res, 200, {
    question: ASK_DEFAULT_QUESTION,
    rules:    ASK_RULES,
    tools:    ASK_TOOLS.filter(t => t !== 'Bash'),
    bash:     ASK_BASH.map(p => p.replace(/:\*$/, '')),
    budget:   ASK_BUDGET_USD,
    efforts:  EFFORTS,
    effort:   ASK_EFFORT,
  })
}

// A command is a markdown file, so its own prose is the help that goes with
// it. The path is looked up here from the title rather than taken from the
// page, so a request cannot point Claude at a file of its choosing.
function commandSource(title) {
  try {
    const entry = getRegistry().get(String(title))
    if (!entry?.filePath) return null
    return rel(global.projectRoot, entry.filePath)
  } catch { return null }
}

async function handleAskClaude(req, res) {
  const foreign = foreignOrigin(req)
  if (foreign) return json(res, 403, { error: `Claude is not asked from ${foreign}` })
  let body
  try { body = await readBody(req) } catch { return json(res, 400, { error: 'Invalid JSON body' }) }
  if (asking) return json(res, 409, { error: 'Claude is still answering' })

  const { askPrompt, gitContext, runAsk } = await import('./ask-claude.js')
  const session = body?.session ? String(body.session) : null
  const context = body?.context && typeof body.context === 'object' ? { ...body.context } : {}
  if (context.command) context['command source'] = commandSource(context.command)
  const prompt  = askPrompt({
    question: body?.question,
    output:   typeof body?.output === 'string' ? body.output : '',
    context,
    git:      session ? null : gitContext(global.projectRoot),
    rules:    typeof body?.rules === 'string' ? body.rules : null,
    followUp: !!session,
  })

  const emit = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`)
  const out  = runAsk({ root: global.projectRoot, prompt, session, effort: body?.effort || undefined, onEvent: emit })
  if (out.error) return json(res, 400, { error: out.error })

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' })
  asking = out.child
  const code = await out.done
  asking = null
  emit({ type: 'done', code })
  res.end()
}

// `:ask`: the same one-at-a-time Claude, pointed at the app instead of the
// tree. Body: { question, as, tenant, session }.
async function handleLiveAsk(req, res) {
  const foreign = foreignOrigin(req)
  if (foreign) return json(res, 403, { error: `the app's agent is not asked from ${foreign}` })
  let body
  try { body = await readBody(req) } catch { return json(res, 400, { error: 'Invalid JSON body' }) }
  if (asking) return json(res, 409, { error: 'Claude is still answering' })
  if (!String(body?.question ?? '').trim()) return json(res, 400, { error: 'ask a question' })

  const { agentPrompt, runAsk } = await import('./ask-claude.js')
  const { agentUrl }            = await import('./live-view.js')
  const session = body?.session ? String(body.session) : null
  const who     = new URLSearchParams()
  if (typeof body?.as === 'string' && body.as.trim())         who.set('as', body.as.trim())
  if (typeof body?.tenant === 'string' && body.tenant.trim()) who.set('tenant', body.tenant.trim())
  const prompt = agentPrompt({ question: body.question, as: who.get('as') ?? '', tenant: who.get('tenant') ?? '', followUp: !!session })

  const emit = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`)
  const out  = runAsk({ root: global.projectRoot, prompt, session, agent: { url: agentUrl(who) }, effort: 'low', onEvent: emit })
  if (out.error) return json(res, 400, { error: out.error })

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' })
  asking = out.child
  const code = await out.done
  asking = null
  emit({ type: 'done', code })
  res.end()
}

function handleAskClaudeStop(req, res) {
  const foreign = foreignOrigin(req)
  if (foreign) return json(res, 403, { error: `Claude is not stopped from ${foreign}` })
  if (!asking) return json(res, 409, { error: 'Claude is not answering' })
  try { process.kill(-asking.pid, 'SIGTERM') } catch {}
  json(res, 200, { ok: true })
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

// The server answers every origin with `Access-Control-Allow-Origin: *`, so a
// page on some other site can send a POST here. A browser always states the
// Origin of a cross-site POST; one naming any host but this server's own is the
// answer, and every POST that writes or starts something refuses it.
function foreignOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return null
  let host = null
  try { host = new URL(origin).host } catch {}
  return host === req.headers.host ? null : origin
}

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

// Anything the page started dies with this process. Registered in
// `startServer` rather than at import in `children.js`, because a module that
// installs a process listener the moment it is required is one a test cannot
// import without inheriting it. `exit` cannot await, which is why the kill is a
// signal.
const reap = async () => {
  try { (await import('./children.js')).killAll() } catch {}
}

/** What a signal does, and what the terminal console's Ctrl+C does: stop
 *  everything the page started, then this process. */
export const shutdown = (code = 0) => reap().finally(() => process.exit(code))

/** `quiet` prints nothing, for a caller that has given the terminal to a
 *  renderer, where a line written past it lands inside the screen. */
export function startServer({ quiet = false } = {}) {
  const server = createServer(route)
  // Loopback only: foreignOrigin lets a POST with no Origin through, because
  // the console's screens send none, so on any wider address another machine
  // could run a command here (FJS-3470).
  server.listen(PORT, '127.0.0.1', () => {
    if (quiet) return
    console.log(`FLI server running on http://localhost:${PORT}`)
    console.log(`  GET  http://localhost:${PORT}/api/commands`)
    console.log(`  POST http://localhost:${PORT}/api/run/:name`)
  })

  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => shutdown())
  server.once('close', reap)

  return server
}
