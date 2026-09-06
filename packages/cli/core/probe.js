// ─── probe.js — the assertions a tutorial step ends with ─────────────────────
//
// A step that runs a command and prints "✓ done" has proved that the command
// exited 0. That is not what a lesson is for: `docs/QUICKSTART.md` §7 exited 0
// on every command it named and had never once put an app on a server. A probe
// asks the world instead — does the port answer, is the row in the database, is
// the container on that image — so a step cannot pass by agreeing with itself.
//
// ── A probe never throws ─────────────────────────────────────────────────────
//
// Every one answers `{ ok, name, asked, got, detail }` and the caller decides.
// Throwing would take the two things that make a halt readable: the runner
// prints a stack for an uncaught error, and it SKIPS the `runOnAbort: true`
// teardown that stops a lesson leaving a container running. `context.config
// .abort` is the ruled refusal path (`FJS-589`) and `must()` below is what sets
// it — non-zero exit, no stack, teardown still runs.
//
// ── Everything that shells out takes its runner ──────────────────────────────
//
// `run` is injected on the three probes that need a subprocess, so the suite
// grades this file with no Docker daemon, no sqlite binary and no network —
// the same reason `@frontierjs/outpost` takes `createDocker({ run })` and the
// same reason its 19 tests need no machine.
//
// Zero dependencies, plain ESM, node or bun: `scripts/ci.mjs` runs on node and
// a caller may run before install.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from 'node:fs'
import { spawnSync }                from 'node:child_process'
import { connect }                  from 'node:net'

// ─── the answer shape ─────────────────────────────────────────────────────────
//
//   name    what was being asked about, in the lesson's words
//   asked   what would have satisfied it
//   got     what actually came back — the half a reader needs to act
//   detail  optional extra body (a response, a nearby line)

const ok   = (name, asked, got, detail) => ({ ok: true,  name, asked, got, detail })
const fail = (name, asked, got, detail) => ({ ok: false, name, asked, got, detail })

// ─── the default runner ───────────────────────────────────────────────────────
// argv, never a shell string: a container name or a path reaching a shell is
// how a probe becomes an injection (Invariant 8's rule, one realm over).

export function runArgv(bin, args, opts = {}) {
  const r = spawnSync(bin, args, { encoding: 'utf8', ...opts })
  return {
    code:   r.status ?? 1,
    stdout: (r.stdout ?? '').trim(),
    stderr: (r.stderr ?? '').trim(),
    error:  r.error ? r.error.message : null,
  }
}

// ─── http ─────────────────────────────────────────────────────────────────────
//
// Retried, because a step that just started a server is racing it. The retry is
// part of the probe rather than the step's business — every caller would
// otherwise write its own sleep, and the sleeps would be tuned to whichever
// machine the author had.

async function attempt(url, { method = 'GET', body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } }
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
    init.headers['content-type'] ??= 'application/json'
  }
  try {
    const res  = await fetch(url, init)
    const text = await res.text()
    return { res, text }
  } catch (err) {
    return { error: err.code || err.message }
  }
}

const wait = (ms) => new Promise(r => setTimeout(r, ms))

export async function httpStatus({ url, method, body, headers, expect = 200, retries = 1, everyMs = 500, name }) {
  const label = name ?? `${method ?? 'GET'} ${url}`
  let last
  for (let i = 0; i < retries; i++) {
    last = await attempt(url, { method, body, headers })
    if (last.res && last.res.status === expect) {
      return ok(label, `status ${expect}`, `status ${last.res.status}`)
    }
    if (i < retries - 1) await wait(everyMs)
  }
  if (last.error) {
    const tried = retries > 1 ? ` after ${retries} tries over ${((retries - 1) * everyMs) / 1000}s` : ''
    return fail(label, `status ${expect}`, `${last.error}${tried}`)
  }
  return fail(label, `status ${expect}`, `status ${last.res.status}`, last.text.slice(0, 400))
}

// The body, not the status. `expect` is a predicate over the parsed JSON, and
// `describe` is what that predicate was looking for said in English — without
// it a failure reads `expected (j) => j.token` at somebody who is learning.
export async function httpJson({ url, method, body, headers, expect, describe, retries = 1, everyMs = 500, name }) {
  const label = name ?? `${method ?? 'GET'} ${url}`
  let last
  for (let i = 0; i < retries; i++) {
    last = await attempt(url, { method, body, headers })
    if (last.res) {
      let json
      try { json = JSON.parse(last.text) } catch { json = undefined }
      if (json !== undefined && expect(json)) {
        // `detail` is TRUNCATED for the diagnosis and `json` is not. A caller
        // that wanted a value out of the body — a token, an id — was parsing
        // `detail` back, which is fine until a body passes 400 characters and
        // then fails as a JSON syntax error about a response that was correct.
        return { ...ok(label, describe ?? 'the body to match', 'it did', last.text.slice(0, 400)), json }
      }
      if (json === undefined) {
        return fail(label, describe ?? 'JSON', 'a body that is not JSON', last.text.slice(0, 400))
      }
    }
    if (i < retries - 1) await wait(everyMs)
  }
  if (last.error) return fail(label, describe ?? 'the body to match', last.error)
  return fail(label, describe ?? 'the body to match', `status ${last.res.status}, and the body did not`, last.text.slice(0, 400))
}

// The body as TEXT, for the things that are not JSON. A dev server answering a
// module is the case this exists for: a page that compiles is a fact about the
// compiler, and asking the server for the module is the only way to get it
// without a browser.
export async function httpText({ url, method, body, headers, needle, describe, retries = 1, everyMs = 500, name }) {
  const label = name ?? `${method ?? 'GET'} ${url}`
  const want  = describe ?? `a body matching ${needle}`
  let last
  for (let i = 0; i < retries; i++) {
    last = await attempt(url, { method, body, headers })
    const hit = last.res && last.res.ok &&
      (typeof needle === 'string' ? last.text.includes(needle) : needle.test(last.text))
    if (hit) {
      return ok(label, want, 'it did', last.text.slice(0, 400))
    }
    if (i < retries - 1) await wait(everyMs)
  }
  if (last.error) return fail(label, want, last.error)
  if (!last.res.ok) return fail(label, want, `status ${last.res.status}`, last.text.slice(0, 400))
  return fail(label, want, 'the body did not match', last.text.slice(0, 400))
}

export async function header({ url, name: hdr, expect, label }) {
  const shown = label ?? `${hdr} on ${url}`
  const got   = await attempt(url)
  if (got.error)  return fail(shown, `${hdr}: ${expect}`, got.error)
  const actual  = got.res.headers.get(hdr)
  if (actual === expect) return ok(shown, `${hdr}: ${expect}`, actual)
  return fail(shown, `${hdr}: ${expect}`, actual === null ? 'the header is absent' : `${hdr}: ${actual}`)
}

// ─── ports ────────────────────────────────────────────────────────────────────

function knock({ port, host = '127.0.0.1', timeoutMs = 400 }) {
  return new Promise((resolve) => {
    const socket = connect({ port, host })
    const done   = (answered) => { socket.destroy(); resolve(answered) }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error',   () => done(false))
  })
}

export async function portAnswering({ port, host, timeoutMs, retries = 1, everyMs = 500, name }) {
  const label = name ?? `something on port ${port}`
  for (let i = 0; i < retries; i++) {
    if (await knock({ port, host, timeoutMs })) return ok(label, `port ${port} answering`, 'it answers')
    if (i < retries - 1) await wait(everyMs)
  }
  return fail(label, `port ${port} answering`, 'nothing is listening')
}

export async function portFree({ port, host, timeoutMs, name }) {
  const label = name ?? `port ${port} free`
  if (await knock({ port, host, timeoutMs })) {
    return fail(label, `port ${port} free`, 'something is already listening there')
  }
  return ok(label, `port ${port} free`, 'it is free')
}

// ─── files ────────────────────────────────────────────────────────────────────

export function fileExists({ path, name }) {
  const label = name ?? path
  return existsSync(path) ? ok(label, 'the file exists', 'it does') : fail(label, 'the file exists', 'it is not there')
}

// `got` is the MATCHING line when it matched and the file's size when it did
// not — a reader chasing a failure wants to know the file was read at all.
export function fileContains({ path, needle, name }) {
  const label = name ?? `${path} contains ${needle}`
  if (!existsSync(path)) return fail(label, String(needle), 'the file is not there')

  const text  = readFileSync(path, 'utf8')
  const lines = text.split('\n')
  const hit   = typeof needle === 'string'
    ? lines.find(l => l.includes(needle))
    : lines.find(l => needle.test(l))

  if (hit !== undefined) return ok(label, String(needle), hit.trim())
  return fail(label, String(needle), `not in ${lines.length} lines of ${path}`)
}

// ─── the database ─────────────────────────────────────────────────────────────
//
// The sharpest probe there is, and the reason a lesson can say a row was
// written rather than that a request answered 201: it reads the file the app
// wrote, through the app's own runtime, with no service in the way.

// Any probe, until it holds. The retry loops above are inside the probes that
// ask over a network, where a connection refused on the first try is ordinary;
// this is for the ones that read something a SEPARATE process is about to
// write — a job finishing a row, a build dropping a file — where the wait is a
// property of the caller's question rather than of the probe.
export async function eventually(probe, { retries = 10, everyMs = 500 } = {}) {
  let last
  for (let i = 0; i < retries; i++) {
    last = await probe()
    if (last.ok) return last
    if (i < retries - 1) await wait(everyMs)
  }
  return last
}

export function sqliteRow({ db, sql, params = [], expect, name, run = runArgv }) {
  const label  = name ?? sql
  // Two things about `bun -e` that this script has to carry itself.
  //
  // The first argument lands at argv[1], not argv[2] — the shape `node -e` uses
  // and one off from a script run as a FILE.
  //
  // And an uncaught throw there exits **0** with nothing on stderr: a missing
  // table, an unreadable file and a syntax error all arrive as success with no
  // output, which this probe would report as "unreadable output:" and a reader
  // would take for a bug in the probe. So the script catches, prints the
  // message, and sets its own exit code.
  const script =
    'try {' +
    '  const { Database } = require("bun:sqlite");' +
    '  const d = new Database(process.argv[1], { readonly: true });' +
    '  console.log(JSON.stringify(d.query(process.argv[2]).all(...JSON.parse(process.argv[3]))));' +
    '} catch (e) { console.error(String((e && e.message) || e)); process.exit(1) }'

  const r = run('bun', ['-e', script, db, sql, JSON.stringify(params)])
  if (r.code !== 0) return fail(label, 'the query to run', r.stderr || r.error || `exit ${r.code}`)

  let rows
  try { rows = JSON.parse(r.stdout) } catch { return fail(label, 'rows', `unreadable output: ${r.stdout.slice(0, 200)}`) }

  const pass = expect ? expect(rows) : rows.length > 0
  if (pass) return ok(label, expect ? 'the rows to match' : 'at least one row', `${rows.length} row(s)`, r.stdout.slice(0, 400))
  return fail(label, expect ? 'the rows to match' : 'at least one row', `${rows.length} row(s)`, r.stdout.slice(0, 400))
}

/** Run statements against a SQLite file — the write half of `sqliteRow`, and
 *  through the same subprocess for the same reason.
 *
 *  `fli` runs on NODE (its own shebang), and `bun:sqlite` cannot be imported
 *  there: a step that opened a database in-process worked under `bun fli.js` and
 *  failed for every person who typed `fli`, with an ESM loader error naming a
 *  protocol rather than the lesson. Bun is a hard requirement of the framework
 *  anyway — the app runs on it — so shelling out to it is the honest answer, and
 *  it makes both directions runner-independent.
 *
 *  The two `bun -e` traps `sqliteRow` documents apply here unchanged: the first
 *  argument is at argv[1], and an uncaught throw exits 0 with nothing on stderr,
 *  so the script catches and sets its own code.
 */
export function sqliteExec({ db, statements, name, run = runArgv }) {
  const label  = name ?? `${statements.length} statement(s)`
  const script =
    'try {' +
    '  const { Database } = require("bun:sqlite");' +
    '  const d = new Database(process.argv[1]);' +
    '  for (const sql of JSON.parse(process.argv[2])) d.run(sql);' +
    '  d.close();' +
    '  console.log("ok");' +
    '} catch (e) { console.error(String((e && e.message) || e)); process.exit(1) }'

  const r = run('bun', ['-e', script, db, JSON.stringify(statements)])
  if (r.code !== 0) return fail(label, 'every statement to run', r.stderr || r.error || `exit ${r.code}`)
  return ok(label, 'every statement to run', `${statements.length} applied`)
}

// ─── docker ───────────────────────────────────────────────────────────────────

export function dockerRunning({ container, name, run = runArgv }) {
  const label = name ?? `container ${container}`
  const r = run('docker', ['inspect', '-f', '{{.State.Running}}', container])
  if (r.code !== 0) {
    const missing = /No such object/i.test(r.stderr)
    return fail(label, 'a running container', missing ? 'there is no such container' : (r.stderr || r.error || `exit ${r.code}`))
  }
  if (r.stdout === 'true') return ok(label, 'a running container', 'it is running')
  return fail(label, 'a running container', `it exists and is not running (Running=${r.stdout})`)
}

export function dockerImageOf({ container, name, run = runArgv }) {
  const label = name ?? `the image behind ${container}`
  const r = run('docker', ['inspect', '-f', '{{.Image}}', container])
  if (r.code !== 0) return fail(label, 'an image id', r.stderr || r.error || `exit ${r.code}`)
  return ok(label, 'an image id', r.stdout)
}

// ─── the machine ──────────────────────────────────────────────────────────────

export function commandExists({ bin, name, run = runArgv }) {
  const label = name ?? bin
  const r = run('sh', ['-c', `command -v ${bin}`])
  if (r.code === 0 && r.stdout) return ok(label, `${bin} on PATH`, r.stdout)
  return fail(label, `${bin} on PATH`, 'it is not installed, or not on this PATH')
}

// ─── a command, run ───────────────────────────────────────────────────────────
//
// The exit code AND what it printed, because the two answer different
// questions: `bun test` with no test files exits 0, and `litestone mutate`
// exits 0 whatever the score. A step asserting only the code is asserting that
// the binary exists.
//
// argv, never a shell string, for `runArgv`'s reason.

export function command({ bin, args = [], cwd, env, needle, expect = 0, name, describe, run = runArgv }) {
  const label = name ?? `${bin} ${args.join(' ')}`
  const r     = run(bin, args, { cwd, ...(env ? { env: { ...process.env, ...env } } : {}) })
  const out   = `${r.stdout}\n${r.stderr}`.trim()
  const tail  = out.split('\n').slice(-25).join('\n')

  if (r.code !== expect)
    return fail(label, describe ?? `exit ${expect}`, `exit ${r.code}${r.error ? ` — ${r.error}` : ''}`, tail)

  if (needle === undefined) return ok(label, describe ?? `exit ${expect}`, `exit ${r.code}`, out)

  const found = needle instanceof RegExp ? needle.test(out) : out.includes(needle)
  return found
    ? ok(label, describe ?? String(needle), 'it is in the output', out)
    : fail(label, describe ?? String(needle), 'it is not in the output', tail)
}

// ─── the diagnosis ────────────────────────────────────────────────────────────
//
// The whole deliverable of a failed step. A stack trace tells somebody learning
// the framework that the framework is broken; this tells them what was asked,
// what came back, what is likely, and the two commands that carry on from here.
//
// Formatted here rather than in the command file so the wording has one owner
// and a test can assert it.

// The leading mark is the LOGGER's — `context.log.error` prints its own ✗, and
// a mark here too gave every failed step a `✗ ✗`. What this owns is the block.
// ─── the page ─────────────────────────────────────────────────────────────────
//
// A page is a PROCESS, so these take one already open rather than opening their
// own: launching Chrome per assertion costs half a second each, and a lesson
// that opened five would be five browsers. `core/browser.js` owns the launch;
// the lesson owns the lifetime, the same split it makes for a server.

/** Evaluate an expression in the page until it satisfies `expect`.
 *
 *  Retried by default, because a page is asynchronous in a way an HTTP response
 *  is not: the markup arrives, then the module, then the mount, then the fetch
 *  the mount made. Asking once asks before the answer exists. */
export async function pageEval({ page, ask, expect, describe, name, retries = 20, everyMs = 250 }) {
  const label = name ?? ask
  let last, err
  for (let i = 0; i < retries; i++) {
    try { last = await page.eval(ask); err = null }
    catch (e) { err = e; last = undefined }
    if (!err && (expect ? expect(last) : Boolean(last)))
      return { ...ok(label, describe ?? 'the page to answer', JSON.stringify(last)), value: last }
    if (i < retries - 1) await wait(everyMs)
  }
  if (err) return fail(label, describe ?? 'the page to answer', `it threw: ${err.message}`)
  return fail(label, describe ?? 'the page to answer', `it answered ${JSON.stringify(last)}`,
    page.errors.length ? page.errors.slice(-5).join('\n') : undefined)
}

/** Nothing threw and nothing was logged as an error while the page was open.
 *
 *  Its own probe, because a component that throws while rendering still leaves a
 *  PARTIAL tree — so an assertion about what is on the page walks straight past
 *  a broken render and reports it as working. */
export function pageClean({ page, name = 'the page reported no errors' }) {
  if (!page.errors.length) return ok(name, 'no exceptions and no console errors', 'none')
  return fail(name, 'no exceptions and no console errors',
    `${page.errors.length}`, page.errors.slice(0, 8).join('\n'))
}

export function formatFailure(result, { likely, reproduce, continues = [] } = {}) {
  const pad   = (label) => `    ${label.padEnd(10)}`
  const lines = [result.name]

  lines.push(pad('asked') + result.asked)
  lines.push(pad('got') + result.got)
  if (result.detail) {
    const body = String(result.detail).split('\n')
    lines.push(pad('body') + body[0])
    for (const l of body.slice(1, 6)) lines.push(' '.repeat(14) + l)
  }
  if (likely)    lines.push(pad('likely') + likely)
  if (reproduce) lines.push(pad('reproduce') + reproduce)
  for (const [i, c] of continues.entries()) {
    lines.push(i === 0 ? pad('continue') + c : ' '.repeat(14) + c)
  }
  return lines.join('\n')
}
