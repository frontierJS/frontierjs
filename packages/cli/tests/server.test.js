import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync } from 'fs'

const __dir = dirname(fileURLToPath(import.meta.url))
global.fliRoot     = resolve(__dir, '..')
global.projectRoot = resolve(__dir, '..')

// Use a port that won't clash with a running dev server
process.env.FLI_PORT = '13141'
const PORT = 13141
const base = `http://localhost:${PORT}`

const { startServer } = await import('../core/server.js')

let server
beforeAll(async () => {
  server = startServer()
  // Wait for the server to be ready
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
})

afterAll(() => {
  server?.close()
})

// ─── Helper: collect all SSE events from a streaming response ─────────────────
async function collectEvents(res) {
  const reader  = res.body.getReader()
  const decoder = new TextDecoder()
  const events  = []
  let buffer    = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try { events.push(JSON.parse(line.slice(6))) } catch {}
      }
    }
  }
  return events
}

// ─── GET /api/commands ────────────────────────────────────────────────────────

describe('GET /api/commands', () => {

  test('returns 200 with an array', async () => {
    const res = await fetch(`${base}/api/commands`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
  })

  test('each entry has a namespaced title', async () => {
    const cmds = await fetch(`${base}/api/commands`).then(r => r.json())
    for (const cmd of cmds) {
      expect(typeof cmd.title).toBe('string')
      expect(cmd.title).toContain(':')
    }
  })

  test('no alias duplicates in list', async () => {
    const cmds   = await fetch(`${base}/api/commands`).then(r => r.json())
    const titles = cmds.map(c => c.title)
    expect(new Set(titles).size).toBe(titles.length)
  })

  test('known commands are present', async () => {
    const cmds   = await fetch(`${base}/api/commands`).then(r => r.json())
    const titles = cmds.map(c => c.title)
    expect(titles).toContain('hello:greet')
    expect(titles).toContain('hello:exec')
    expect(titles).toContain('make:command')
  })

})

// ─── GET /api/commands/:name ──────────────────────────────────────────────────

describe('GET /api/commands/:name', () => {

  test('returns full metadata for a known command', async () => {
    const res  = await fetch(`${base}/api/commands/hello:greet`)
    expect(res.status).toBe(200)
    const meta = await res.json()
    expect(meta.title).toBe('hello:greet')
    expect(meta.description).toBeTruthy()
    expect(Array.isArray(meta.args)).toBe(true)
    expect(typeof meta.flags).toBe('object')
  })

  test('resolves by alias', async () => {
    const res  = await fetch(`${base}/api/commands/greet`)
    expect(res.status).toBe(200)
    const meta = await res.json()
    expect(meta.title).toBe('hello:greet')
  })

  test('returns 404 for unknown command', async () => {
    const res  = await fetch(`${base}/api/commands/nope:missing`)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBeTruthy()
  })

})

// ─── POST /api/run/:name ──────────────────────────────────────────────────────

describe('POST /api/run/:name', () => {

  test('returns 200 with SSE content-type', async () => {
    const res = await fetch(`${base}/api/run/hello:greet`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ args: ['World'], flags: {} }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
  })

  test('emits output events containing the greeting', async () => {
    const res = await fetch(`${base}/api/run/hello:greet`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ args: ['World'], flags: { times: 2 } }),
    })
    const events  = await collectEvents(res)
    const outputs = events.filter(e => e.type === 'output')
    expect(outputs.length).toBe(2)
    expect(outputs.every(e => e.text.includes('World'))).toBe(true)
  })

  test('last event is always done', async () => {
    const res = await fetch(`${base}/api/run/hello:greet`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ args: ['World'], flags: {} }),
    })
    const events = await collectEvents(res)
    expect(events.at(-1)?.type).toBe('done')
  })

  test('--shout flag uppercases output', async () => {
    const res = await fetch(`${base}/api/run/hello:greet`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ args: ['World'], flags: { shout: true } }),
    })
    const events = await collectEvents(res)
    const text   = events.filter(e => e.type === 'output').map(e => e.text).join('')
    expect(text).toContain('HELLO, WORLD!')
  })

  test('dry run emits a dry log event instead of executing', async () => {
    const res = await fetch(`${base}/api/run/hello:exec`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ args: ['/tmp'], flags: { dry: true } }),
    })
    const events  = await collectEvents(res)
    const dryLogs = events.filter(e => e.type === 'log' && e.level === 'dry')
    expect(dryLogs.length).toBeGreaterThan(0)
    expect(dryLogs[0].text.length).toBeGreaterThan(0)
  })

  test('returns 404 for unknown command', async () => {
    const res = await fetch(`${base}/api/run/nope:missing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(404)
  })

  test('emits error event when a flag has the wrong type', async () => {
    // 'times' is type:number — passing a string triggers a type error in getConfig
    // which throws before any prompts run, so the SSE stream gets an error event
    const res = await fetch(`${base}/api/run/hello:greet`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ args: ['World'], flags: { times: 'not-a-number' } }),
    })
    const events = await collectEvents(res)
    const errors = events.filter(e => e.type === 'error')
    expect(errors.length).toBeGreaterThan(0)
  })

})

// ─── GET / ────────────────────────────────────────────────────────────────────

describe('GET /', () => {

  test('serves the Web GUI HTML', async () => {
    const res  = await fetch(`${base}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('<title>fli')
    expect(html).toContain('id="app"')
  })

  // The GUI is written in @frontierjs/css (Invariant 13) and asks this server
  // for it, so a page that renders unstyled is a 404 here and nothing else.
  test('serves the styling language the GUI links', async () => {
    const html = await fetch(`${base}/`).then(r => r.text())
    expect(html).toContain('href="/fli.css"')

    const res = await fetch(`${base}/fli.css`, { redirect: 'manual' })
    // A tree with no readable @frontierjs/css redirects to the published
    // bundle instead; either answer is the stylesheet arriving.
    if (res.status === 302) {
      expect(res.headers.get('location')).toContain('@frontierjs/css')
      return
    }
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/css')
    const css = await res.text()
    // The layer order declaration is the one line that must lead the bundle.
    expect(css.startsWith('@layer ')).toBe(true)
    expect(css).toContain('.topbar')
  })

  test('serves the highlighter as a module', async () => {
    const res = await fetch(`${base}/glow.js`)
    // Absent, the GUI shows a command's source unhighlighted rather than not
    // at all — so a 404 here is a legal answer and must stay a 404, not a 500.
    expect([200, 404]).toContain(res.status)
    if (res.status === 200) {
      expect(res.headers.get('content-type')).toContain('javascript')
      expect(await res.text()).toContain('export function glow')
    }
  })

})

// ─── CORS ─────────────────────────────────────────────────────────────────────

describe('CORS', () => {

  test('OPTIONS preflight returns 204 with CORS headers', async () => {
    const res = await fetch(`${base}/api/commands`, { method: 'OPTIONS' })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  test('all API responses include CORS allow-origin header', async () => {
    const res = await fetch(`${base}/api/commands`)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

})

describe('GET /api/commands/:name — _source blocks', () => {

  test('response includes _source object', async () => {
    const res  = await fetch(`${base}/api/commands/hello:greet`)
    const meta = await res.json()
    expect(meta._source).toBeDefined()
    expect(typeof meta._source).toBe('object')
  })

  test('_source.segments is an array of typed segments', async () => {
    const res  = await fetch(`${base}/api/commands/hello:exec`)
    const meta = await res.json()
    expect(Array.isArray(meta._source.segments)).toBe(true)
    // hello:exec has at least one js code block
    const codeSegments = meta._source.segments.filter(s => s.type === 'code')
    expect(codeSegments.length).toBeGreaterThan(0)
    expect(codeSegments[0].lang).toBe('js')
    expect(typeof codeSegments[0].content).toBe('string')
  })

  test('_source.script contains the script block when present', async () => {
    const res  = await fetch(`${base}/api/commands/hello:exec`)
    const meta = await res.json()
    // hello:exec has a <script> block with buildCommand
    expect(meta._source.script).toBeTruthy()
    expect(typeof meta._source.script).toBe('string')
    expect(meta._source.script).toContain('buildCommand')
  })

  test('_source.script is null when no <script> block', async () => {
    // git:stash is frontmatter + one js block — no <script>, no prose.
    // If it ever grows either, repoint this and the next test at another
    // bare command rather than relaxing the assertion.
    const res  = await fetch(`${base}/api/commands/git:stash`)
    const meta = await res.json()
    expect(meta._source.script).toBeNull()
  })

  test('_source.segments contains no prose entries when command has no prose', async () => {
    const res  = await fetch(`${base}/api/commands/git:stash`)
    const meta = await res.json()
    const proseSegments = meta._source.segments.filter(s => s.type === 'prose')
    expect(proseSegments).toHaveLength(0)
  })

})

describe('GET /api/commands — _source field', () => {

  test('every command in the list has a _source field', async () => {
    const res  = await fetch(`${base}/api/commands`)
    const cmds = await res.json()
    for (const cmd of cmds) {
      expect(['core', 'project']).toContain(cmd._source)
    }
  })

  test('core commands are labeled correctly', async () => {
    const res  = await fetch(`${base}/api/commands`)
    const cmds = await res.json()
    const makeCmd = cmds.find(c => c.title === 'make:command')
    expect(makeCmd).toBeDefined()
    expect(makeCmd._source).toBe('core')
  })

  test('project commands are labeled correctly', async () => {
    const res  = await fetch(`${base}/api/commands`)
    const cmds = await res.json()
    const greet = cmds.find(c => c.title === 'hello:greet')
    expect(greet).toBeDefined()
    expect(greet._source).toBe('project')
  })

})

// ─── GET /api/runnables and /api/state ────────────────────────────────────────
//
// The control surface's two answers: what could run, and what is running. They
// are separate endpoints because they have different lifetimes — the inventory
// is a tree walk cached for seconds, the state is a probe answered per poll —
// and because one of them can be wrong in a way the other cannot: a stale
// inventory shows a row that has been renamed, a stale state shows a server
// that is down as up, and only the second is dangerous.

describe('GET /api/runnables', () => {

  test('answers rows and the kinds a page groups by', async () => {
    const res = await fetch(`${base}/api/runnables`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.rows)).toBe(true)
    expect(body.kinds).toContain('surface')
    expect(body.kinds).toContain('tool')
  })

  test('every row carries an id and a source', async () => {
    const { rows } = await (await fetch(`${base}/api/runnables`)).json()
    for (const r of rows) {
      expect(typeof r.id).toBe('string')
      expect(typeof r.source).toBe('string')
      expect(r).toHaveProperty('start')
      expect(r).toHaveProperty('port')
    }
  })

  test('the tools group is derived from the reserved block', async () => {
    // `packages/cli` is its own project root here, so surfaces and drives are
    // whatever the fixture has; the tools come from ports.js and are always
    // there. A slot added to GLOBAL is a row with nothing edited.
    const { rows } = await (await fetch(`${base}/api/runnables`)).json()
    const tools = rows.filter(r => r.kind === 'tool')
    expect(tools.length).toBeGreaterThan(0)
    for (const t of tools) expect(t.port).toBeGreaterThanOrEqual(8500)
  })

})

describe('GET /api/state', () => {

  test('answers a state for every row, keyed by the same id', async () => {
    const { rows }  = await (await fetch(`${base}/api/runnables`)).json()
    const { state } = await (await fetch(`${base}/api/state`)).json()
    for (const r of rows) expect(state[r.id]).toBeDefined()
  })

  test('a row with no port is `unknown`, never `down`', async () => {
    // *Nothing here can tell* is a different sentence from *not running*, and
    // collapsing them makes every drive and every suite read as stopped.
    const { rows }  = await (await fetch(`${base}/api/runnables`)).json()
    const { state } = await (await fetch(`${base}/api/state`)).json()
    const portless  = rows.filter(r => r.port === null)
    expect(portless.length).toBeGreaterThan(0)
    for (const r of portless) expect(state[r.id].state).toBe('unknown')
  })

  test('a tool moves down → up → down as something binds its port', async () => {
    const { rows } = await (await fetch(`${base}/api/runnables`)).json()
    const tool = rows.find(r => r.kind === 'tool')
    const at   = async () => (await (await fetch(`${base}/api/state`)).json()).state[tool.id].state

    expect(await at()).toBe('down')

    // Bound on 0.0.0.0, because that is what an app binds and what the probe
    // has to collide with either way round.
    const { createServer } = await import('http')
    const squatter = createServer((_, res) => res.end())
    await new Promise(r => squatter.listen(tool.port, '0.0.0.0', r))
    try {
      expect(await at()).toBe('up')
    } finally {
      await new Promise(r => squatter.close(r))
    }

    expect(await at()).toBe('down')
  })

})

// ─── POST /api/start/:id · POST /api/stop/:id ────────────────────────────────
//
// The property worth pinning here is the one that is not about behavior at
// all: the caller sends an ID and never a command. What runs comes from the
// inventory, which comes from a file in the tree — so a request can choose
// among the project's own declared commands and cannot name one of its own.
//
// The stop refusal is the other half. This server stops what it started and
// says so about anything else, because a page that offered otherwise is a
// button that kills a process somebody else is depending on.

describe('POST /api/start/:id and /api/stop/:id', () => {

  const post = (path) => fetch(`${base}${path}`, { method: 'POST' })

  test('an id nothing declares is a 404, not a spawn', async () => {
    const res = await post('/api/start/surface%3Anot%2Fa%2Frow')
    expect(res.status).toBe(404)
    expect((await res.json()).error).toMatch(/no runnable called/)
  })

  test('a command in the request body is not a command', async () => {
    // The route takes no body at all. A caller who sends one is choosing
    // nothing: the id is the whole of what they may say.
    const res = await fetch(`${base}/api/start/surface%3Anope`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ argv: ['rm', '-rf', '/'], start: 'rm -rf /' }),
    })
    expect(res.status).toBe(404)
  })

  test('a row whose runner this page does not spawn is refused with the line to type', async () => {
    const { rows } = await (await fetch(`${base}/api/runnables`)).json()
    const foreign  = rows.find(r => r.argv && r.argv[0] !== 'bun' && r.argv[0] !== 'fli')
    if (!foreign) return   // a project with no such row has nothing to assert

    const res = await post(`/api/start/${encodeURIComponent(foreign.id)}`)
    expect(res.status).toBe(400)
    const { error } = await res.json()
    expect(error).toMatch(/Run it yourself: cd /)
    expect(error).toContain(foreign.argv.join(' '))
  })

  test('stopping something this server did not start is refused by name', async () => {
    const { rows } = await (await fetch(`${base}/api/runnables`)).json()
    const any = rows.find(r => r.start)
    const res = await post(`/api/stop/${encodeURIComponent(any.id)}`)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/not started here/)
  })

  // Starting one for real is NOT tested here, and the reason is a defect this
  // file caused: the first cut started the first `bun` task it found, which in
  // this package is `bun run test` — so the suite ran itself, the inner copy
  // bound this port, and the outer one failed with EADDRINUSE from inside
  // `startServer`. A route that spawns a real process cannot be exercised from
  // the suite that spawns it. The table itself is covered hermetically in
  // `children.test.js` through its `spawnFn` seam, and the real thing — start,
  // poll, stop — is in the browser drive, where the server is a separate
  // process on the test tier.

})

// ─── GET /api/proves ─────────────────────────────────────────────────────────
//
// Not *what can run* but *what should I run, for what I have just changed*.
// The reader is covered over a fixture in `tests/proofs.test.js`; what is here
// is the endpoint's own two contracts — the shape it answers in, and what it
// does in a project that has no proof table, which is every project but this
// one.
//
// `projectRoot` is `packages/cli` in this file, and `packages/cli/CLAUDE.md`
// declares no such table. So this suite runs the negative control by default,
// which is the case a fixture is least likely to be written for.

describe('GET /api/proves', () => {

  test('answers the shape a panel reads, with a time on it', async () => {
    const res = await fetch(`${base}/api/proves`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.files)).toBe(true)
    expect(Array.isArray(body.rows)).toBe(true)
    expect(typeof body.at).toBe('string')
  })

  test('a project with no proof table answers no rows rather than failing', async () => {
    // The table is the workspace's. A client app has none, and an endpoint that
    // errored there would put a red panel on every scaffolded app's dashboard.
    const body = await (await fetch(`${base}/api/proves`)).json()
    expect(body.error).toBeUndefined()
    expect(body.rows).toEqual([])
  })

  test('the files it reports are relative to the project, not to the git root', async () => {
    // `packages/cli` is a directory inside this repository, and git answers
    // paths from the repository root. Handing those to a matcher reading a
    // table written in project-relative paths matches nothing — or matches the
    // wrong row, which is worse.
    const { files } = await (await fetch(`${base}/api/proves`)).json()
    for (const f of files) expect(f.startsWith('packages/cli/')).toBe(false)
  })

  test('takes no parameter, so nothing a caller sends reaches git', async () => {
    // `fli proves --from <ref>` takes a ref because the person typing it chose
    // it. A ref arriving over HTTP is caller-supplied text on a git command
    // line, and the branch view is not worth that.
    const a = await (await fetch(`${base}/api/proves`)).json()
    const b = await (await fetch(`${base}/api/proves?from=$(touch /tmp/fli-proves-pwned)`)).json()
    expect(b.files).toEqual(a.files)
    expect(existsSync('/tmp/fli-proves-pwned')).toBe(false)
  })

})


// ─── GET /api/health/:id ─────────────────────────────────────────────────────
//
// A port answering is not an app working. `busyPorts` opens a socket, which is
// equally true of a Junction app whose database probe is failing — so the page
// said `answering` about both, and §6 of the control-surface paper had said so
// for weeks.
//
// Three answers and the third is the one worth having: `ok`, `degraded`, and
// *nothing here answers a health question*, which is the honest state of a Vite
// dev server and is not a failure.

describe('GET /api/health/:id', () => {

  /** A server on `port` answering the health shape at `path`, and 404 elsewhere. */
  async function serve(port, path, body) {
    const { createServer } = await import('http')
    const s = createServer((req, res) => {
      if (req.url !== path) { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    })
    await new Promise(r => s.listen(port, '0.0.0.0', r))
    return () => new Promise(r => s.close(r))
  }

  const OK = { status: 'ok', app: 'shop', version: '1.0.0', uptime: 12,
               checks: { database: { status: 'ok', latencyMs: 1 } }, ts: 'now' }

  async function toolRow() {
    const { rows } = await (await fetch(`${base}/api/runnables`)).json()
    return rows.find(r => r.kind === 'tool')
  }

  test('answers the health shape, and says which path answered', async () => {
    const row  = await toolRow()
    const stop = await serve(row.port, '/health', OK)
    try {
      const body = await (await fetch(`${base}/api/health/${encodeURIComponent(row.id)}`)).json()
      expect(body.answered).toBe(true)
      expect(body.path).toBe('/health')
      expect(body.health.status).toBe('ok')
    } finally { await stop() }
  })

  test('and finds it under the prefix, because apiPrefix moves every route', async () => {
    // `/health` is registered with `app.get`, which is `apiPrefix`'s one owner —
    // so where it lives is a fact about the app's config and not about its port.
    // Probed and reported rather than derived (Invariant 3's rule for the same
    // class of question).
    const row  = await toolRow()
    const stop = await serve(row.port, '/api/health', { ...OK, status: 'degraded' })
    try {
      const body = await (await fetch(`${base}/api/health/${encodeURIComponent(row.id)}`)).json()
      expect(body.path).toBe('/api/health')
      expect(body.health.status).toBe('degraded')
    } finally { await stop() }
  })

  test('a 200 of something else is not a health answer', async () => {
    // A web surface serves an index page on every path. Without the shape test
    // the page would read a Vite dev server as a healthy API.
    const row  = await toolRow()
    const stop = await serve(row.port, '/health', { hello: 'world' })
    try {
      const body = await (await fetch(`${base}/api/health/${encodeURIComponent(row.id)}`)).json()
      expect(body.answered).toBe(false)
      expect(body.why).toMatch(/nothing answered/)
    } finally { await stop() }
  })

  test('nothing listening answers `not answered` rather than an error', async () => {
    const row  = await toolRow()
    const body = await (await fetch(`${base}/api/health/${encodeURIComponent(row.id)}`)).json()
    expect(body.answered).toBe(false)
    expect(body.error).toBeUndefined()
  })

  test('a row with no port says so, rather than being probed', async () => {
    const { rows } = await (await fetch(`${base}/api/runnables`)).json()
    const portless = rows.find(r => r.port === null)
    const body = await (await fetch(`${base}/api/health/${encodeURIComponent(portless.id)}`)).json()
    expect(body.answered).toBe(false)
    expect(body.why).toMatch(/no port/)
  })

  test('an unknown id is a 404 and never a probe of something else', async () => {
    const res = await fetch(`${base}/api/health/${encodeURIComponent('surface:nope/api')}`)
    expect(res.status).toBe(404)
  })

})


// ─── GET /api/check and GET /api/doctor ──────────────────────────────────────
//
// Two engines that existed and were nowhere a person looks. They stay two
// endpoints because they are two questions: `check` grades the PROJECT against
// the rules this framework publishes, `doctor` grades the MACHINE the commands
// are about to run on.
//
// Both are called IN PROCESS — `core/checks.js` is the same engine
// `scripts/ci.mjs` runs and `core/doctor.js` the one the command renders — so
// there is no `--json` to parse and no second answer to either question.

describe('GET /api/check', () => {

  test('answers per scope, with the counts a header line needs', async () => {
    const body = await (await fetch(`${base}/api/check`)).json()
    expect(body.error).toBeUndefined()
    expect(Array.isArray(body.scopes)).toBe(true)
    expect(typeof body.errors).toBe('number')
    expect(typeof body.warns).toBe('number')
  })

  test('every scope says how many rules RAN, not only what they found', async () => {
    // A scope with no findings and a scope where nothing ran read the same on a
    // page that only carries findings, and only one of them is good news.
    const { scopes } = await (await fetch(`${base}/api/check`)).json()
    expect(scopes.length).toBeGreaterThan(0)
    for (const s of scopes) {
      expect(typeof s.ran).toBe('number')
      expect(Array.isArray(s.findings)).toBe(true)
    }
    expect(scopes.some(s => s.ran > 0)).toBe(true)
  })

  test('the workspace scope is asked as well as each app', async () => {
    // The same two passes `scripts/ci.mjs`'s `structure` phase makes, so a rule
    // loosened for one is loosened for both.
    const { scopes } = await (await fetch(`${base}/api/check`)).json()
    expect(scopes.some(s => s.label === 'packages')).toBe(true)
  })

  test('a finding carries a path relative to the project, never an absolute one', async () => {
    // An absolute path on a page is one nobody can click and one that leaks the
    // machine it was read on.
    const { scopes } = await (await fetch(`${base}/api/check`)).json()
    for (const s of scopes) {
      for (const f of s.findings) {
        if (f.file) expect(f.file.startsWith('/')).toBe(false)
        expect(['error', 'warn']).toContain(f.severity)
        expect(typeof f.message).toBe('string')
      }
    }
  })

  test('it answers while the server is still serving other requests', async () => {
    // `runChecks` is synchronous and one scope is ~half a second, so five in a
    // row froze this server: the state poll missed, every badge on the page
    // emptied, and a start button did nothing for a second and a half. The
    // yield between scopes does not make it faster, it makes this true.
    const check = fetch(`${base}/api/check`).then(r => r.json())
    const state = await fetch(`${base}/api/state`).then(r => r.json())
    expect(state.state).toBeDefined()
    expect((await check).scopes).toBeDefined()
  })

})

describe('GET /api/doctor', () => {

  test('answers the machine`s own report', async () => {
    const body = await (await fetch(`${base}/api/doctor`)).json()
    expect(body.error).toBeUndefined()
    expect(Array.isArray(body.system)).toBe(true)
    expect(Array.isArray(body.config)).toBe(true)
    expect(typeof body.checks).toBe('number')
    expect(typeof body.blocked).toBe('number')
  })

  test('and it is the same engine the command renders', async () => {
    const body = await (await fetch(`${base}/api/doctor`)).json()
    const { diagnose } = await import('../core/doctor.js')
    const direct = diagnose({ root: global.projectRoot, fliRoot: global.fliRoot })
    // The endpoint adds namespaces off the registry, so the SYSTEM half is what
    // must agree — and it must, because there is one implementation of it.
    expect(body.system.map(b => `${b.name}:${b.ok}`)).toEqual(direct.system.map(b => `${b.name}:${b.ok}`))
  })

})
