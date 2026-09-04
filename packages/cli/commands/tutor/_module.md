---
namespace: tutor
description: Learn FrontierJS by building an app that really runs, one lesson at a time
---

<script>
// ─── the tutor namespace ──────────────────────────────────────────────────────
//
// A lesson is a command with steps. Each step narrates its own prose, runs the
// real command, and then ASKS THE WORLD whether it worked — a port, a row, a
// container. That last part is the whole design: `docs/QUICKSTART.md` §7 exited
// 0 on every command it named and had never once put an app on a server.
//
// Three modules do the work and none of them live here: `core/tutor.js` (where
// the app lives, and what a previous run finished), `core/probe.js` (the
// assertions), `core/prompt.js` (asking a person something). This file is the
// wiring, because a `<script>` block is not importable by a test.

const { createPrompts } = await import(new URL('file://' + global.fliRoot + '/core/prompt.js'))
const probe             = await import(new URL('file://' + global.fliRoot + '/core/probe.js'))
const T                 = await import(new URL('file://' + global.fliRoot + '/core/tutor.js'))

const { existsSync, mkdirSync, openSync, readFileSync, writeFileSync, appendFileSync, copyFileSync, rmSync } = await import('node:fs')
const { join, resolve, basename } = await import('node:path')
const { homedir }        = await import('node:os')
const { spawn }          = await import('node:child_process')

// ─── openTutor ────────────────────────────────────────────────────────────────
//
// Every lesson's orchestrator body calls this and nothing else. It settles the
// three things a step must never decide for itself: where the app lives, what a
// previous run already finished, and who is being asked the questions.
//
// The hydrate is UP FRONT rather than only on replay, so `--step 8` standing
// alone still knows the app directory step 2 created. Without it that flag
// fails as a TypeError several frames from anything a reader can act on.

const openTutor = (context, lesson, { ephemeral = [], base } = {}) => {
  const ws = T.tutorWorkspace({
    name: context.flag.workspace,
    tmp:  context.flag.tmp || !context.flag.workspace,
    cwd:  process.cwd(),
    base,
  })

  const verdict = T.journalVerdict(T.readJournal(ws.dir), { workspace: ws.dir })
  if (!verdict.ok) {
    context.log.error(verdict.message)
    context.config.abort = true
    return null
  }

  context.config.ws     = ws
  context.config.lesson = lesson
  context.config.app    = ws.app
  // ONE reader for the lesson, closed by the finish step. Not one per question:
  // a piped stdin is DRAINED by the first reader, so a second one waits on a
  // stream that has already ended and the lesson hangs after step 1.
  context.config.prompts = createPrompts({ yes: Boolean(context.flag.yes) })

  const recorder = T.makeRecorder({ workspace: ws.dir, lesson, context, ephemeral })
  if (context.flag.restart) recorder.restart()
  context.config.journal = recorder

  Object.assign(context.config, T.hydrate(recorder.doc(), lesson))

  context.vars.workspace = ws.dir
  context.vars.app       = ws.app

  // Whatever this run starts, this run stops — on the way out of `--step N`,
  // which never reaches the teardown step, and on a Ctrl-C, which reaches
  // nothing at all. Without it a lesson leaves a dev server holding the port
  // that its own step 1 refuses on the next run, and blames the person for it.
  //
  // Synchronous by necessity: an `exit` handler cannot await, which is why
  // `stopServers` signals rather than waiting for anything.
  if (!context.config.__trapped) {
    context.config.__trapped = true
    const off = () => stopServers(context)
    process.once('exit', off)
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      process.once(sig, () => { off(); process.exit(130) })
    }
  }

  context.log.info(`workspace: ${ws.dir}${ws.kind === 'temp' ? ' (temporary)' : ''}`)
  return ws
}

// ─── narrate ──────────────────────────────────────────────────────────────────
// A step's own prose, rendered at the moment it is reached, and then a gate.
// `printPlan` is bound to the STEP file rather than the orchestrator
// (`FJS-725`), so this is the step talking rather than the lesson's front page
// repeated nine times.
//
// **The default is a walk-through.** A lesson that runs eleven steps to
// completion while you are still reading step two is a transcript rather than a
// lesson, so each step says what it is about to do and then waits. `--yes` runs
// the whole thing without stopping, which is what CI passes and what a second
// run through material you have already read wants.
//
// The question is the step's own `description:`, so it is about THIS step
// rather than a generic *continue?* — and it costs no second place to keep in
// step with what the step does.
const stepDescription = (context) => {
  try {
    const head = readFileSync(context.filePath, 'utf8').split('\n---')[0]
    return head.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? null
  } catch { return null }
}

const narrate = async (context) => {
  context.printPlan()

  // `--step N` is a person naming the one thing they want done. Asking again is
  // asking twice.
  if (context.flag.yes || context.flag.step) return true

  const what = stepDescription(context)
  const go   = await context.config.prompts.confirm(`  ${what ? `${what} —` : ''} ready?`, { default: true })

  if (go) return true

  // Not a refusal. `stop` is the ruled verdict for a deliberate early exit that
  // SUCCEEDED (`FJS-589`), so the lesson exits 0 — but the servers this run
  // started are still this run's to stop — and a `stop` skips the finish step
  // that would have done both that and closed the reader.
  stopServers(context)
  context.config.prompts.close()

  // `context.log`, not `log`: this module's script runs outside a step body, and
  // the bare binding is only in scope inside one.
  const where = context.flag.workspace ? ` --workspace ${context.flag.workspace}` : ''
  context.log.info('')
  context.log.info('  Stopped here — nothing after this step ran.')
  if (context.config.appDir) context.log.info(`  The app is at ${context.config.appDir}`)
  context.log.info(`  Pick up where you left off:  fli ${context.config.lesson}${where}`)
  context.log.info('')

  // Named so the recorder can drop the row: a declined step must not be
  // remembered as done, or the resume skips the one place they stopped.
  context.config.__declinedAt = basename(context.filePath, '.md')
  context.config.stop = true
  return false
}

// ─── must ─────────────────────────────────────────────────────────────────────
//
// The gate. A probe answers rather than throwing, and this is what turns a
// `false` into a stop — through `context.config.abort`, which is the ruled
// refusal path (`FJS-589`): non-zero exit, no stack trace, and the teardown
// step still runs so a lesson cannot leave a container behind.
//
// `diagnosis` is written beside the probe because the step is the only thing
// that knows what it just did. `continue` is filled in here, since where to
// pick up from is the lesson's business rather than the step's.

const must = async (context, result, diagnosis = {}) => {
  const r = await result
  if (r.ok) {
    // The NAME alone. A probe's `got` is written for a failure — "it does",
    // "it is free" — and reading it back on the success line says nothing twice.
    context.log.success(r.name)
    return true
  }

  const lesson = context.config.lesson
  const step   = context.config.__step
  const where  = context.flag.workspace ? ` --workspace ${context.flag.workspace}` : ''

  // A step's own `detail` wins over the probe's, for the reason `likely` does:
  // the probe saw a status, the step knows it had just started a server and can
  // hand over its output.
  const shown = diagnosis.detail ? { ...r, detail: diagnosis.detail } : r

  context.log.error(probe.formatFailure(shown, {
    ...diagnosis,
    continues: diagnosis.continues ?? [
      `fli ${lesson}${where}`,
      step ? `fli ${lesson}${where} --step ${step}` : null,
    ].filter(Boolean),
  }))

  context.config.abort = true
  return false
}

// ─── needs ────────────────────────────────────────────────────────────────────
//
// A step run on its own — `--step 7`, or the first step after a `--restart` —
// has only what the journal could hydrate. Where that is not enough, say so by
// NAME: without this the step reads `undefined` as a path and Node throws
// `The "path" argument must be of type string`, which is several frames from
// anything a reader can act on and says nothing about the lesson.

// `from` may name one step or map each key to its own, because two missing
// facts usually come from two different steps and pointing at one of them sends
// the reader to a step that was never going to establish the other.
const needs = (context, keys, { from } = {}) => {
  const missing = keys.filter((k) => context.config[k] === undefined)
  if (!missing.length) return true

  const stepFor = (k) => (typeof from === 'string' ? from : from?.[k])
  const named   = [...new Set(missing.map(stepFor).filter(Boolean))]
  const where   = context.flag.workspace ? ` --workspace ${context.flag.workspace}` : ''

  context.log.error([
    `this step needs ${missing.join(', ')}, and this workspace has not got that far yet`,
    named.length ? `    ${'earlier'.padEnd(10)}${named.join(', ')}` : null,
    `    ${'continue'.padEnd(10)}fli ${context.config.lesson}${where}`,
  ].filter(Boolean).join('\n'))

  context.config.abort = true
  return false
}

// ─── note ─────────────────────────────────────────────────────────────────────
// What this step found, handed to the steps after it — and to the steps after
// it on a LATER run, where this one is replayed into a no-op and runs none of
// its own code.

const remember = (context, stepName, facts) => T.note(context, stepName, facts)

// ─── where a scaffold comes from ──────────────────────────────────────────────
//
// Inside this workspace the framework is the tree beside you and `--source
// local` is the only honest answer; anywhere else it is what npm serves. Stated
// rather than guessed, because the two fail in opposite directions: `local`
// outside the repo resolves nothing, and `npm` inside it silently tests the
// PUBLISHED framework against a tree you are editing.

const defaultSource = () =>
  existsSync(resolve(global.fliRoot, '..', 'sierra', 'package.json')) ? 'local' : 'npm'

// ─── the servers ──────────────────────────────────────────────────────────────
//
// A lesson has to leave an app RUNNING across several steps, and a running
// process is the one thing the journal cannot hold: the row says `succeeded`
// and the port is dead. So the step that starts them is declared `ephemeral`
// and runs every time, and this is what it calls.
//
// Detached, in a process group of its own, because `bun run dev:web` spawns
// vite as a child and killing the parent alone leaves the port held — which the
// next run then refuses at step 1, blaming the person for a process this
// tutorial started.
//
// Output goes to a file rather than to the terminal. A dev server writing over
// the lesson's own prose makes both unreadable, and the diagnosis on a failed
// health check needs somewhere to point.

const startServer = async (context, { name, script, cwd, env = {}, port, path = '/', ready = 40, logs }) => {
  context.config.__servers ??= {}
  if (context.config.__servers[name]) return context.config.__servers[name]

  // `logs` is for a server started inside a directory the lesson does not own:
  // `tutor:fleet` runs basecamp out of the checkout, and a log written beside
  // its source is a lesson leaving files in somebody's repository.
  const logDir = logs ?? join(cwd, '.tutor')
  mkdirSync(logDir, { recursive: true })
  const logPath = join(logDir, `${name}.log`)
  const out     = openSync(logPath, 'w')

  const child = spawn('bun', ['run', script], {
    cwd,
    env:      { ...process.env, ...env },
    stdio:    ['ignore', out, out],
    detached: true,
  })
  child.unref()

  const rec = { name, pid: child.pid, port, logPath, child }
  context.config.__servers[name] = rec

  // The port answering is not the same as the app being up — vite binds before
  // it has a route table — so this asks the URL a caller would ask for.
  const url = `http://127.0.0.1:${port}${path}`
  rec.up = await probe.httpStatus({ url, retries: ready, everyMs: 500, name: `${name} answers ${path}` })
  return rec
}

const serverLog = (rec, lines = 6) => {
  try { return readFileSync(rec.logPath, 'utf8').trim().split('\n').slice(-lines).join('\n') }
  catch { return '(no output)' }
}

// Stopping is by GROUP, and a failure to stop is not a failure of the lesson:
// the process may already be gone, which is the ordinary case on a rerun.
const stopServers = (context) => {
  for (const rec of Object.values(context.config.__servers ?? {})) {
    try { process.kill(-rec.pid, 'SIGTERM') } catch { try { rec.child?.kill('SIGTERM') } catch {} }
  }
  context.config.__servers = {}
}

const stopServer = (context, name) => {
  const rec = context.config.__servers?.[name]
  if (!rec) return
  try { process.kill(-rec.pid, 'SIGTERM') } catch { try { rec.child?.kill('SIGTERM') } catch {} }
  delete context.config.__servers[name]
}

// A step run on its own — `--step 8` — has no servers, because the step that
// starts them did not run. `needs()` covers a missing FACT and cannot cover a
// missing PROCESS, so a step that talks to the API asks for it rather than
// assuming: if something is already answering health it is used as it stands,
// which is also what a person with the app open in another terminal wants.
const ensureApi = async (context) => {
  const port    = context.config.apiPort
  const already = await probe.httpStatus({ url: `http://127.0.0.1:${port}/api/health`, name: 'the API is up' })
  if (already.ok) return already

  const api = await startServer(context, {
    name:   'api',
    script: 'start',
    cwd:    context.config.appDir,
    env:    { PORT: String(port) },
    port,
    path:   '/api/health',
  })
  return api.up
}

// The web server's half of the same problem. `--step 9` reaches a lesson whose
// dev server is not running, and the Mesa step asks that server to compile a
// file — so it is the process, not a fact, and `needs()` cannot cover it.
const ensureWeb = async (context) => {
  const port    = context.config.webPort
  const already = await probe.httpStatus({ url: `http://127.0.0.1:${port}/`, name: 'the web server is up' })
  if (already.ok) return already

  const web = await startServer(context, {
    name:   'web',
    script: 'dev:web',
    cwd:    context.config.appDir,
    env:    { WEB_PORT: String(port), FLI_PORT_BE: String(context.config.apiPort) },
    port,
    path:   '/',
  })
  return web.up
}

// The API reads db/schema.lite once, at boot. A step that changes the schema
// has to put the process through it again or the app goes on serving the shape
// it started with — and the request that follows is refused for a model the
// file plainly declares.
const restartApi = async (context) => {
  stopServer(context, 'api')
  await new Promise((r) => setTimeout(r, 700))
  return startServer(context, {
    name:   'api',
    script: 'start',
    cwd:    context.config.appDir,
    env:    { PORT: String(context.config.apiPort) },
    port:   context.config.apiPort,
    path:   '/api/health',
  })
}

const apiUrl = (context, path = '') => `http://127.0.0.1:${context.config.apiPort}/api${path}`

// The control plane of `tutor:fleet` is a different app and mounts its services
// at the root — junction's default `apiPrefix` is '' and basecamp keeps it, so
// `/api` here would be a 404 on every call.
const hubUrl = (context, path = '') => `http://127.0.0.1:${context.config.apiPort}${path}`

// ─── the fleet's two processes ────────────────────────────────────────────────
//
// `ensureApi`'s shape for the pair `tutor:fleet` runs, and they are here rather
// than in the steps for the reason that one owns them: the outpost is started
// by step 5 and needed again by step 6, and a step run on its own — `--step 6`
// — reaches neither. Two environments written twice is how the lesson and the
// resume end up disagreeing about which secret is the fleet's.

const startHub = (context) => startServer(context, {
  name:   'basecamp',
  script: 'start',
  cwd:    context.config.basecamp,
  logs:   join(context.config.ws.dir, '.tutor'),
  env:    {
    NODE_ENV:       'development',
    PORT:           String(context.config.apiPort),
    DATABASE_URL:   join(context.config.ws.dir, 'basecamp.db'),
    // Both databases have to be redirected, not one. The audit trail is a
    // second `database` block with a RELATIVE path, so it follows the process
    // CWD — which is the checkout — and a lesson that set only `DATABASE_URL`
    // writes its rows into the developer's own trail (`FJS-633`).
    AUDIT_PATH:     join(context.config.ws.dir, 'audit'),
    OUTPOST_SECRET: context.config.secret,
  },
  port:   context.config.apiPort,
  path:   '/setup/probe',
})

const startOutpost = (context) => startServer(context, {
  name:   'outpost',
  script: 'start',
  cwd:    context.config.outpost,
  logs:   join(context.config.ws.dir, '.tutor'),
  env:    {
    OUTPOST_SERVER_ID:  context.config.serverId,
    OUTPOST_SECRET:     context.config.secret,
    BASECAMP_URL:       hubUrl(context),
    OUTPOST_PORT:       String(context.config.outpostPort),
    OUTPOST_PUBLIC_URL: `http://127.0.0.1:${context.config.outpostPort}`,
    OUTPOST_WORK_DIR:   join(context.config.ws.dir, 'outpost-work'),
  },
  port:   context.config.outpostPort,
  path:   '/health',
})

// Anything already answering is used as it stands, which is also what somebody
// with the control plane open in another terminal wants.
const ensureFleet = async (context, { outpost = false } = {}) => {
  const up = await probe.httpStatus({ url: hubUrl(context, '/setup/probe'), name: 'the control plane is up' })
  if (!up.ok) {
    const hub = await startHub(context)
    if (!hub.up.ok) return { ...hub.up, detail: serverLog(hub) }
  }
  if (!outpost) return up.ok ? up : { ok: true, name: 'the control plane is up' }

  const machine = await probe.httpStatus({ url: `http://127.0.0.1:${context.config.outpostPort}/health`, name: 'the outpost is up' })
  if (machine.ok) return machine
  const started = await startOutpost(context)
  return started.up.ok ? started.up : { ...started.up, detail: serverLog(started) }
}

// ─── the seed, edited ─────────────────────────────────────────────────────────
//
// A lesson about access control has to CHANGE the schema and watch the answer
// change. `editSchema` refuses when its anchor is not there rather than writing
// the file back unchanged — a rewrite that silently missed leaves the lesson
// asserting the old behavior and blaming the framework for it.

const schemaFile = (context) => join(context.config.appDir, 'db', 'schema.lite')

const editSchema = (context, from, to) => {
  const path = schemaFile(context)
  const src  = readFileSync(path, 'utf8')
  // The target is asked about FIRST. Lessons share a named workspace and several
  // of them raise the same gate, so an app arriving already changed is the
  // ordinary case — and asking for `from` first reports that as *the schema has
  // no such line*, which is true and is the wrong answer.
  if (src.includes(to))    return { ok: true,  already: true }
  if (!src.includes(from)) return { ok: false, why: `the schema has no ${JSON.stringify(from)} to change` }
  writeFileSync(path, src.replace(from, to), 'utf8')
  return { ok: true }
}

// A field added to `model Note`, which is what `tutor:change` edits three times.
// Refuses rather than writing the file back unchanged, for `editSchema`'s reason.
const addNoteField = (context, line) => {
  const path = schemaFile(context)
  const src  = readFileSync(path, 'utf8')
  const name = line.trim().split(/\s+/)[0]

  const at = src.indexOf('model Note {')
  if (at === -1) return { ok: false, why: 'the seed has no `model Note {` block' }

  const end = src.indexOf('\n}', at)
  if (end === -1) return { ok: false, why: '`model Note {` is not closed' }

  const body = src.slice(at, end)
  if (new RegExp(`^\\s*${name}\\s`, 'm').test(body)) {
    // Already declared — replace the line rather than adding a second, since
    // the three steps of this lesson change the SAME column in turn.
    const next = src.slice(0, at) + body.replace(new RegExp(`^\\s*${name}\\s.*$`, 'm'), line) + src.slice(end)
    if (next === src) return { ok: true, already: true }
    writeFileSync(path, next, 'utf8')
    return { ok: true }
  }

  writeFileSync(path, src.slice(0, end) + '\n' + line + src.slice(end), 'utf8')
  return { ok: true }
}

const pushSchema = (context) =>
  context.exec({ command: `${context.fli} db:push`, cwd: context.config.appDir })

// An account, and the token it answers with. Two callers is the whole shape of
// this lesson — a refusal proves nothing without an otherwise identical call
// that is allowed.
// ─── a raw socket ─────────────────────────────────────────────────────────────
//
// The client `@frontierjs/junction/client` gives a browser is the ordinary way
// to hold one of these, and it is the wrong instrument for `tutor:live`: it
// signs in, and the question the lesson asks is what an UNSIGNED connection
// receives. A raw socket is the only client here that can be genuinely signed
// out — which is why the hole this lesson teaches survived in the example app
// until a drive was written that could open one.
//
// The token rides the UPGRADE, never a frame: the identity of a connection is
// established once, when it is made, and a frame that could name its own
// principal would be a frame that could name anybody's.
const openSocket = async (context, { token, channels, settleMs = 250 }) => {
  const url    = `ws://127.0.0.1:${context.config.apiPort}/ws${token ? `?token=${token}` : ''}`
  const frames = []
  const ws     = new WebSocket(url)

  const connected = await new Promise((resolve) => {
    const give = setTimeout(() => resolve(false), 5000)
    ws.onmessage = (e) => {
      let frame
      try { frame = JSON.parse(e.data) } catch { return }
      frames.push(frame)
      if (frame.type === 'connected') { clearTimeout(give); resolve(true) }
    }
    ws.onerror = () => { clearTimeout(give); resolve(false) }
  })

  if (!connected) return { ok: false, ws, events: () => [] }

  ws.send(JSON.stringify({ type: 'subscribe', channels }))
  // Subscribing is a frame with no acknowledgement, so a publish sent in the
  // same millisecond can reach the server before the subscription does. The
  // wait is short and it is the difference between a lesson that is flaky and
  // one that teaches.
  await new Promise((r) => setTimeout(r, settleMs))

  return {
    ok: true,
    ws,
    events: (prefix) => frames.filter(f => typeof f.event === 'string' && f.event.startsWith(prefix)),
  }
}

// The pair `tutor:live` asks every question with, and the reason it is here
// rather than in a step: steps 5 and 6 open the same two clients against the
// same publish, and two sockets built twice is how a lesson ends up proving
// that two DIFFERENT connections behave differently.
const bothSockets = async (context, { channels = ['notes'] } = {}) => {
  const signedIn  = await openSocket(context, { token: context.config.userToken, channels })
  const anonymous = await openSocket(context, { token: null, channels })

  const close = () => { try { signedIn.ws.close() } catch {} ; try { anonymous.ws.close() } catch {} }

  if (!signedIn.ok || !anonymous.ok) {
    close()
    await must(context, {
      ok:    false,
      name:  'two sockets are connected',
      asked: 'a connected frame on each',
      got:   `signed in: ${signedIn.ok ? 'yes' : 'no'}, anonymous: ${anonymous.ok ? 'yes' : 'no'}`,
    }, {
      likely: 'the app does not configure channels(), or an anonymous upgrade is being refused',
    })
    return { ok: false, close, settle: async () => ({ signedIn: [], anonymous: [] }) }
  }

  return {
    ok: true,
    close,
    // A broadcast is not the response, so it has not happened when the response
    // arrives. This waits once for both, then closes — the alternative is each
    // caller inventing its own sleep and the two drifting apart.
    settle: async (ms = 700) => {
      await new Promise((r) => setTimeout(r, ms))
      const heard = { signedIn: signedIn.events('notes '), anonymous: anonymous.events('notes ') }
      close()
      return heard
    },
  }
}

const createNote = (context, title) => probe.httpJson({
  url:      apiUrl(context, '/notes'),
  method:   'POST',
  headers:  { 'content-type': 'application/json', authorization: `Bearer ${context.config.userToken}` },
  body:     JSON.stringify({ title, body: 'written over HTTP', done: false }),
  expect:   (j) => typeof j.id !== 'undefined',
  describe: 'the note was created',
  name:     `POST /api/notes — ${title}`,
})

// Running `fli` and reading the ANSWER rather than the exit code. `context.exec`
// is a shell and prints; a lesson that has to branch on a verdict needs the
// document. Never a bare `fli` — that is whatever global install the machine
// happens to have, which is not the build under test.
const fliJson = (context, args, cwd) => {
  const r = probe.runArgv(process.execPath, [join(global.fliRoot, 'bin', 'fli.js'), ...args], { cwd })
  let json = null
  try { json = JSON.parse(r.stdout) } catch {}
  return { code: r.code, json, stdout: r.stdout, stderr: r.stderr }
}

const signIn = (context, email, password) => probe.httpJson({
  url:      apiUrl(context, '/auth/login'),
  method:   'POST',
  headers:  { 'content-type': 'application/json' },
  body:     JSON.stringify({ email, password }),
  expect:   (j) => typeof j.token === 'string',
  describe: 'a session token',
  name:     `sign in as ${email}`,
})

const registerAccount = (context, { email, password, name }) => probe.httpJson({
  url:      apiUrl(context, '/auth/register'),
  method:   'POST',
  headers:  { 'content-type': 'application/json' },
  body:     JSON.stringify({ email, password, name }),
  expect:   (j) => typeof j.token === 'string',
  describe: 'a session token',
  name:     `register ${email}`,
})

// `--step N` on its own reuses the tokens the journal recorded, and a session
// minted on another day is expired — which arrives as a 401 the step then blames
// on the gate it is teaching. Signing both callers in again costs two requests
// and only happens for a standalone step, because auth rate-limits login and a
// full run would spend that budget for nothing.
const refreshTokens = async (context) => {
  if (!context.flag.step) return true
  const { user, admin, password } = context.config
  if (!user || !admin || !password) return true

  // Signing in is an HTTP request, so the API has to be up before the tokens
  // can be refreshed — a standalone step has started nothing.
  const up = await ensureApi(context)
  if (!up.ok) return must(context, up, {
    likely: 'nothing is answering on the API port — run this lesson from the start',
  })

  for (const [email, key] of [[user, 'userToken'], [admin, 'adminToken']]) {
    const r = await signIn(context, email, password)
    if (!r.ok) return must(context, r, {
      likely: 'the accounts step 3 made are gone — run the lesson from the start',
    })
    context.config[key] = r.json.token
  }
  return true
}

const asCaller = (token) => (token
  ? { 'content-type': 'application/json', authorization: `Bearer ${token}` }
  : { 'content-type': 'application/json' })

// ─── the machine ──────────────────────────────────────────────────────────────
//
// A deploy target can be `localhost`. `core/machine.js` is the one owner of
// (host, script) → the argv that runs it there, and the script travels on stdin
// to `sh -s` either way — so a deploy to this machine is the same pipeline, the
// same journal and the same revert as a deploy over ssh. The only thing it does
// not exercise is ssh itself, which is what makes a deploy lesson runnable at
// all.

// The local-server rewrite has ONE owner and it is `core/tutor.js` — the deploy
// CI phase runs the same function, so a recipe that drifts is caught by the only
// thing that exercises it.
const pointAtLocalServer = T.pointAtLocalServer

const sh = (bin, args, opts = {}) => probe.runArgv(bin, args, opts)

// Committed with an identity of the lesson's own: a tutorial must not depend on
// the person having configured git, and must not write their name into a
// throwaway repository either.
const git = (cwd, args) =>
  sh('git', ['-c', 'user.email=tutor@frontier.invalid', '-c', 'user.name=fli tutor', ...args], { cwd })

const shortCommit = (dir) => sh('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir }).stdout

const imageBehind = (container) => probe.dockerImageOf({ container }).got

// Removing the container and every image the lesson built. Failures are ignored
// on purpose: the ordinary case on a second run is that none of it is there.
const dockerSweep = (container, appName) => {
  sh('docker', ['rm', '-f', container, `${container}_replaced`])
  for (const line of sh('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}']).stdout.split('\n')) {
    const tag = line.trim()
    if (tag.startsWith(`${appName}:`)) sh('docker', ['rmi', '-f', tag])
  }
}

// The app directory of the lesson in progress.
const appDir = (context) => join(context.config.ws.dir, context.config.app)
</script>

Eight lessons, in order. Each one leaves an app you can open.

- tutor:app — an empty directory to a running app with a model of your own in it
- tutor:access — the gate and the row policy, watched refusing somebody
- tutor:live — a write reaching a second client, and who it does not reach
- tutor:jobs — work that outlives the request, and the file it is queued in
- tutor:site — a public site built ahead of time, and the check on what it published
- tutor:deploy — a real deploy to this machine, and a revert that really reverts
- tutor:change — changing a schema that is already deployed
- tutor:fleet — basecamp, and a machine reporting in

Every step ends in an assertion against the running world rather than an exit
code, so a lesson that passes is a lesson that worked.

Each step says what it is about to do and waits for you before doing it. Press
enter to go on, or n to stop — a lesson you stop is picked up where you left
off, so stopping costs nothing. --yes runs a whole lesson without stopping,
which is what CI passes and what a second run wants.

Where the app is built: pass --workspace <dir> to keep what you build, or --tmp
for a throwaway one. --restart begins a lesson again; --step N runs one step on
its own.

Writing a step — two things the compiler decides for you, both of which look
like prose and are not:

- An INDENTED block after a blank line is compiled as raw JavaScript, so a
  schema line shown four spaces in is a syntax error rather than a sample. Fence
  it as text instead. `bun run test`'s parse sweep catches this, because it
  walks every command file including these.
- A bash-fenced block is EXECUTED as a zx template. A command shown for reading
  is fenced console or text.
- A script tag at the start of a line is HOISTED to module scope, together with
  everything down to the last closing tag in the file — so a .mesa sample cannot
  be shown whole. Show its two halves apart, and say why.

And one the runner decides: a step that needs a fact an earlier step
established must say so through needs(), or it reads undefined as a path and
Node throws about an argument type — several frames from anything the reader
can act on.
