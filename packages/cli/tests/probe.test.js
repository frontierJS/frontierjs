// probe.test.js — the assertions a lesson ends with, graded themselves.
//
// Two rules this file exists to hold. **A probe never throws**: a step that
// refuses does it through `context.config.abort`, and an exception would take
// the `runOnAbort` teardown with it and leave a container running. And **a
// failure is a diagnosis** — asked, got, likely, continue — because the reader
// is somebody learning the framework, for whom a stack trace reads as the
// framework being broken.
//
// Every subprocess probe is graded through an injected runner, so this needs no
// Docker daemon and no network. The one exception is `sqliteRow`, which is
// asked of a REAL database file written here: it is the probe whose whole value
// is that it reads what the app wrote, and a faked runner would grade the
// argv rather than the answer.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createServer }                     from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir }                           from 'node:os'
import { join }                             from 'node:path'
import { Database }                         from 'bun:sqlite'

import {
  httpStatus, httpJson, httpText, header, portAnswering, portFree,
  fileExists, fileContains, sqliteRow, sqliteExec, eventually, dockerRunning, dockerImageOf,
  commandExists, formatFailure,
} from '../core/probe.js'

// ─── a real server on an ephemeral port ──────────────────────────────────────
// Port 0 and read the number back, the rule `@frontierjs/testing` already
// holds: a literal collides with whatever else the machine is running.

let server, base, port

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'x-fjs-build': 'abc1234' })
      res.end(JSON.stringify({ status: 'ok' }))
      return
    }
    if (req.url === '/token') {
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ token: 'sk-live', user: { userId: 7 } }))
      return
    }
    if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ token: 'sk-live', filler: 'x'.repeat(600) }))
      return
    }
    if (req.url === '/html') { res.writeHead(200); res.end('<p>not json</p>'); return }
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ message: 'no' }))
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  port = server.address().port
  base = `http://127.0.0.1:${port}`
})

afterAll(() => server?.close())

// A closed port. Asked for the same way, then released.
const closedPort = async () => {
  const s = createServer()
  await new Promise(r => s.listen(0, '127.0.0.1', r))
  const p = s.address().port
  await new Promise(r => s.close(r))
  return p
}

describe('httpStatus', () => {
  test('passes on the expected code', async () => {
    const r = await httpStatus({ url: `${base}/health` })
    expect(r.ok).toBe(true)
    expect(r.got).toBe('status 200')
  })

  test('fails on a different code, and carries the body', async () => {
    const r = await httpStatus({ url: `${base}/nope`, expect: 200 })
    expect(r.ok).toBe(false)
    expect(r.got).toBe('status 401')
    expect(r.detail).toContain('no')
  })

  test('a refused connection reports the refusal, not an exception', async () => {
    const r = await httpStatus({ url: `http://127.0.0.1:${await closedPort()}/`, retries: 2, everyMs: 10 })
    expect(r.ok).toBe(false)
    // bun says ConnectionRefused where node says ECONNREFUSED, and the probe
    // passes the runtime's own word through rather than translating it.
    expect(r.got).toMatch(/ConnectionRefused|ECONNREFUSED|fetch failed|Unable to connect/i)
    expect(r.got).toContain('after 2 tries')
  })

  test('an expected 401 is a pass — a refusal is what lesson 2 asserts', async () => {
    const r = await httpStatus({ url: `${base}/nope`, expect: 401 })
    expect(r.ok).toBe(true)
  })
})

describe('httpJson', () => {

  test('hands back the PARSED body, and it is not the truncated detail', async () => {
    // `detail` is cut to 400 characters for the diagnosis, and a caller wanting
    // a token out of the body was parsing that back — fine until a correct
    // response is longer than the cut, and then a JSON syntax error about a
    // request that worked.
    const r = await httpJson({ url: `${base}/big`, expect: (j) => Boolean(j.token), describe: 'a token' })

    expect(r.ok).toBe(true)
    expect(r.json.token).toBe('sk-live')
    expect(r.json.filler.length).toBe(600)
    expect(r.detail.length).toBeLessThanOrEqual(400)
  })

  test('a FAILING one carries no parsed body — there is nothing a caller should read off it', async () => {
    const r = await httpJson({ url: `${base}/token`, expect: (j) => j.token === 'other', describe: 'a different token' })
    expect(r.ok).toBe(false)
    expect(r.json).toBeUndefined()
  })

  test('grades the body, not the status', async () => {
    const r = await httpJson({ url: `${base}/token`, method: 'POST', body: { a: 1 },
                               expect: (j) => Boolean(j.token), describe: 'a token' })
    expect(r.ok).toBe(true)
  })

  test('a body that is not JSON says so rather than failing the predicate', async () => {
    const r = await httpJson({ url: `${base}/html`, expect: () => true, describe: 'anything' })
    expect(r.ok).toBe(false)
    expect(r.got).toContain('not JSON')
  })

  test('a predicate that does not hold reports the status and the body', async () => {
    const r = await httpJson({ url: `${base}/token`, expect: (j) => j.token === 'other', describe: 'a different token' })
    expect(r.ok).toBe(false)
    expect(r.asked).toBe('a different token')
    expect(r.detail).toContain('sk-live')
  })
})

describe('httpText', () => {
  test('a string needle in a body that is not JSON', async () => {
    const r = await httpText({ url: `${base}/html`, needle: 'not json' })
    expect(r.ok).toBe(true)
  })

  test('a regular expression matches across lines', async () => {
    const r = await httpText({ url: `${base}/html`, needle: /<p>.*<\/p>/ })
    expect(r.ok).toBe(true)
  })

  test('a needle that is absent reports the body rather than the status', async () => {
    const r = await httpText({ url: `${base}/html`, needle: 'nope', describe: 'the module' })
    expect(r.ok).toBe(false)
    expect(r.got).toBe('the body did not match')
    expect(r.detail).toContain('not json')
  })

  // The case it exists for: a dev server that could not compile the file
  // answers a 500 whose body is the compiler's own error, and reading that as
  // *the needle is missing* hides the sentence that says what is wrong.
  test('a failing status is reported as the status', async () => {
    const r = await httpText({ url: `${base}/nope`, needle: 'anything' })
    expect(r.ok).toBe(false)
    expect(r.got).toContain('status 401')
  })
})

describe('header', () => {
  test('matches', async () => {
    const r = await header({ url: `${base}/health`, name: 'x-fjs-build', expect: 'abc1234' })
    expect(r.ok).toBe(true)
  })

  test('an absent header is said differently from a wrong one', async () => {
    const absent = await header({ url: `${base}/health`, name: 'x-nope', expect: 'v' })
    const wrong  = await header({ url: `${base}/health`, name: 'x-fjs-build', expect: 'v' })
    expect(absent.got).toContain('absent')
    expect(wrong.got).toContain('abc1234')
  })
})

describe('ports', () => {
  test('answering', async () => {
    expect((await portAnswering({ port })).ok).toBe(true)
    expect((await portFree({ port })).ok).toBe(false)
  })

  test('free', async () => {
    const p = await closedPort()
    expect((await portFree({ port: p })).ok).toBe(true)
    expect((await portAnswering({ port: p, retries: 2, everyMs: 10 })).ok).toBe(false)
  })
})

describe('files', () => {
  let dir
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'fjs-probe-'))
    writeFileSync(join(dir, 'schema.lite'), 'model Note {\n  id Int @id\n  @@gate("0.4.4.6")\n}\n')
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test('fileExists both ways', () => {
    expect(fileExists({ path: join(dir, 'schema.lite') }).ok).toBe(true)
    expect(fileExists({ path: join(dir, 'nope.lite') }).ok).toBe(false)
  })

  test('fileContains answers the MATCHING LINE, which is what a reader wants', () => {
    const r = fileContains({ path: join(dir, 'schema.lite'), needle: '@@gate' })
    expect(r.ok).toBe(true)
    expect(r.got).toBe('@@gate("0.4.4.6")')
  })

  test('a RegExp needle works and a miss counts the lines it read', () => {
    expect(fileContains({ path: join(dir, 'schema.lite'), needle: /model\s+Note/ }).ok).toBe(true)
    const miss = fileContains({ path: join(dir, 'schema.lite'), needle: 'model Order' })
    expect(miss.ok).toBe(false)
    expect(miss.got).toContain('lines')
  })

  test('a missing file is not a missing needle', () => {
    const r = fileContains({ path: join(dir, 'gone.lite'), needle: 'x' })
    expect(r.ok).toBe(false)
    expect(r.got).toContain('not there')
  })
})

describe('eventually', () => {
  test('returns as soon as the probe holds', async () => {
    let calls = 0
    const r = await eventually(() => {
      calls += 1
      return { ok: calls === 2, name: 'n', asked: 'a', got: String(calls) }
    }, { retries: 5, everyMs: 1 })
    expect(r.ok).toBe(true)
    expect(calls).toBe(2)
  })

  // The LAST failure is returned, not the first — a diagnosis has to describe
  // the state the caller is actually looking at.
  test('gives up with the last failure', async () => {
    let calls = 0
    const r = await eventually(() => ({ ok: false, name: 'n', asked: 'a', got: String(++calls) }),
      { retries: 3, everyMs: 1 })
    expect(r.ok).toBe(false)
    expect(r.got).toBe('3')
  })
})

describe('sqliteRow — against a real database', () => {
  let dir, db
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'fjs-probe-db-'))
    db  = join(dir, 'app.db')
    const d = new Database(db)
    d.run('CREATE TABLE note (id INTEGER PRIMARY KEY, title TEXT)')
    d.run("INSERT INTO note (title) VALUES ('first')")
    d.close()
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test('finds the row the app wrote', () => {
    const r = sqliteRow({ db, sql: 'SELECT * FROM note' })
    expect(r.ok).toBe(true)
    expect(r.detail).toContain('first')
  })

  test('parameters are bound, never interpolated', () => {
    expect(sqliteRow({ db, sql: 'SELECT * FROM note WHERE title = ?', params: ['first'] }).ok).toBe(true)
    expect(sqliteRow({ db, sql: 'SELECT * FROM note WHERE title = ?', params: ['other'] }).ok).toBe(false)
  })

  test('the table being absent is a failure and not a crash', () => {
    const r = sqliteRow({ db, sql: 'SELECT * FROM ledger' })
    expect(r.ok).toBe(false)
    expect(r.got).toMatch(/no such table/i)
  })

  test('an expect predicate grades the rows', () => {
    expect(sqliteRow({ db, sql: 'SELECT * FROM note', expect: (rows) => rows.length === 1 }).ok).toBe(true)
    expect(sqliteRow({ db, sql: 'SELECT * FROM note', expect: (rows) => rows.length === 2 }).ok).toBe(false)
  })
})

describe('sqliteExec — the write half, and the reason it is a subprocess', () => {
  let dir, db
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'fjs-probe-exec-'))
    db  = join(dir, 'made.db')
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  // `fli` runs on node, where `bun:sqlite` cannot be imported at all — so a step
  // that opened a database in-process worked under `bun fli.js` and failed for
  // everyone who typed `fli`. Both halves go through the same subprocess.
  test('creates a database a real reader can then read', () => {
    const made = sqliteExec({ db, statements: [
      'CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE)',
      "INSERT INTO customers (email) VALUES ('ada@example.test')",
    ] })
    expect(made.ok).toBe(true)
    expect(sqliteRow({ db, sql: 'SELECT email FROM customers' }).detail).toContain('ada@example.test')
  })

  // `bun -e` exits 0 with nothing on stderr for an uncaught throw, so the script
  // catches and sets its own code — without that a broken statement arrives as
  // success and the caller builds on a database that was never made.
  test('a bad statement fails with what SQLite said, and does not crash', () => {
    const r = sqliteExec({ db, statements: ['CREATE TABLE'] })
    expect(r.ok).toBe(false)
    expect(r.got).toMatch(/incomplete input|syntax error|near/i)
  })

  test('statements run in order — a later one may depend on an earlier', () => {
    const one = join(dir, 'ordered.db')
    expect(sqliteExec({ db: one, statements: [
      'CREATE TABLE a (id INTEGER PRIMARY KEY)',
      'INSERT INTO a (id) VALUES (1)',
      'CREATE INDEX a_by_id ON a(id)',
    ] }).ok).toBe(true)
    expect(sqliteRow({ db: one, sql: 'SELECT id FROM a' }).ok).toBe(true)
  })
})

describe('docker — through an injected runner', () => {
  const runner = (answers) => (bin, args) => answers(bin, args)

  test('running', () => {
    const r = dockerRunning({ container: 'app-api', run: runner(() => ({ code: 0, stdout: 'true', stderr: '', error: null })) })
    expect(r.ok).toBe(true)
  })

  test('a container that exists and is stopped is not the same as one that is absent', () => {
    const stopped = dockerRunning({ container: 'c', run: runner(() => ({ code: 0, stdout: 'false', stderr: '', error: null })) })
    const absent  = dockerRunning({ container: 'c', run: runner(() => ({ code: 1, stdout: '', stderr: 'Error: No such object: c', error: null })) })
    expect(stopped.got).toContain('not running')
    expect(absent.got).toContain('no such container')
  })

  test('the image id comes back so two deploys can be compared', () => {
    const r = dockerImageOf({ container: 'c', run: runner(() => ({ code: 0, stdout: 'sha256:abc', stderr: '', error: null })) })
    expect(r.got).toBe('sha256:abc')
  })

  test('the container name reaches argv, never a shell string', () => {
    let seen
    dockerRunning({ container: 'a b; rm -rf /', run: (bin, args) => { seen = { bin, args }; return { code: 0, stdout: 'true' } } })
    expect(seen.bin).toBe('docker')
    expect(seen.args).toContain('a b; rm -rf /')
  })
})

describe('commandExists', () => {
  test('finds a binary that is really there', () => {
    expect(commandExists({ bin: 'sh' }).ok).toBe(true)
  })

  test('a missing one fails rather than throwing', () => {
    const r = commandExists({ bin: 'definitely-not-a-real-binary-xyz' })
    expect(r.ok).toBe(false)
    expect(r.got).toContain('not installed')
  })
})

describe('formatFailure', () => {
  test('carries asked, got, likely and both ways to continue', () => {
    const text = formatFailure(
      { ok: false, name: 'the API does not answer health', asked: 'status 200', got: 'ECONNREFUSED after 10 tries' },
      { likely: '`bun run dev` exited', continues: ['fli tutor:app', 'fli tutor:app --step 4'] },
    )
    // the ✗ is the logger's — see formatFailure
    expect(text.split('\n')[0]).toBe('the API does not answer health')
    expect(text).toContain('asked')
    expect(text).toContain('status 200')
    expect(text).toContain('ECONNREFUSED')
    expect(text).toContain('likely')
    expect(text).toContain('fli tutor:app --step 4')
  })

  test('says nothing about fields it was not given', () => {
    const text = formatFailure({ ok: false, name: 'x', asked: 'a', got: 'b' })
    expect(text).not.toContain('likely')
    expect(text).not.toContain('continue')
  })

  test('a long body is trimmed rather than printed whole', () => {
    const text = formatFailure({ ok: false, name: 'x', asked: 'a', got: 'b', detail: Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') })
    expect(text).toContain('line 0')
    expect(text).not.toContain('line 30')
  })
})
