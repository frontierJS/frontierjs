// test/busy-timeout.test.ts — does a connection WAIT for the write lock?
//
// SQLite's default is zero: a connection that finds the lock held fails with
// `SQLITE_BUSY` immediately. `busy_timeout` was set on four connections in this
// workspace and absent from four others, so whether a database waited was an
// accident of which file opened it (`FJS-569`) — and the one with no wait was
// the `logger` index, which is schema-global and therefore the single file every
// tenant and every process writes.
//
// The second half (`FJS-D155`) is where the number comes FROM: option → env →
// default, with no `database { }` spelling, because how long to wait for another
// process is a fact about this process and the same schema is opened by an API
// answering a person and a queue draining a batch.
//
// **Behavioral, not a pragma read.** Asserting `PRAGMA busy_timeout` says the
// statement ran; it does not say a second writer survives, which is the claim.
// So every case here really takes the lock from a second connection and really
// tries to write through the client — the shape that produced the original
// crash. A 250ms hold against a 5s floor is decisive in both directions: with
// the floor the write goes through, without it the failure lands in about 1ms.

import { test, expect, describe, afterEach } from 'bun:test'
import { Database }    from 'bun:sqlite'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir }      from 'node:os'
import { join }        from 'node:path'
import { createClient } from '../src/index.js'
import { DEFAULT_BUSY_TIMEOUT_MS, BUSY_TIMEOUT_ENV, applyBusyTimeout,
         resolveBusyTimeout, busyTimeoutFor, validateBusyTimeout } from '../src/core/pragmas.js'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'busy-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

/**
 * Hold the write lock on `path` for `ms` — from a SEPARATE PROCESS, and that is
 * the whole reason this helper is not four lines.
 *
 * `bun:sqlite` is synchronous, so a connection waiting on the lock blocks the
 * thread it is on. Hold the lock in THIS process behind a `setTimeout` and the
 * waiting write blocks the event loop, the timer never fires, the lock is never
 * released, and the wait can only expire — a deadlock that looks exactly like
 * the missing timeout it was written to detect.
 *
 * A second process makes progress on its own, which is the only situation where
 * `busy_timeout` is any use at all, and the situation the crash came from.
 *
 * Resolves once the lock is actually HELD, so a caller cannot race the taking.
 */
async function holdWriteLock(path: string, ms: number): Promise<void> {
  const child = Bun.spawn(['bun', '-e', `
    const { Database } = require('bun:sqlite')
    const db = new Database(${JSON.stringify(path)})
    db.run('BEGIN IMMEDIATE')
    console.log('HELD')
    setTimeout(() => { db.run('ROLLBACK'); db.close() }, ${ms})
  `], { stdout: 'pipe' })

  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let seen = ''
  while (!seen.includes('HELD')) {
    const { value, done } = await reader.read()
    if (done) break
    seen += decoder.decode(value)
  }
}

describe('the floor is one number, in one place', () => {
  test('it is a real wait, not a zero', () => {
    expect(DEFAULT_BUSY_TIMEOUT_MS).toBeGreaterThanOrEqual(1000)
  })

  test('a connection given the floor waits; one without it fails at once', () => {
    // The negative control, and the reason this file exists: the SAME two
    // connections, differing only in whether the floor was applied.
    const path = join(tmp(), 'raw.db')
    const owner = new Database(path)
    owner.run('PRAGMA journal_mode = WAL')
    owner.run('CREATE TABLE t (id INTEGER PRIMARY KEY)')

    for (const withFloor of [false, true]) {
      const writer = new Database(path)
      if (withFloor) applyBusyTimeout(writer)

      owner.run('BEGIN IMMEDIATE')
      const started = Date.now()
      let threw = false
      try { writer.run('INSERT INTO t (id) VALUES (NULL)') } catch { threw = true }
      const waited = Date.now() - started
      owner.run('ROLLBACK')
      writer.close()

      if (withFloor) {
        // It still fails — the lock is held for the whole attempt — but it
        // SPENT the timeout first, which is the difference that matters.
        expect(threw).toBe(true)
        expect(waited).toBeGreaterThan(DEFAULT_BUSY_TIMEOUT_MS * 0.8)
      } else {
        expect(threw).toBe(true)
        expect(waited).toBeLessThan(100)
      }
    }
    owner.close()
    // The `withFloor` branch deliberately spends the whole timeout, so this one
    // case costs DEFAULT_BUSY_TIMEOUT_MS by construction and needs longer than bun's
    // 5s default. Shortening it would mean asserting a number the code does not use.
  }, DEFAULT_BUSY_TIMEOUT_MS * 4)
})

describe('every database a client opens waits', () => {
  test('the main database — a held lock is waited out, not refused', async () => {
    const path = join(tmp(), 'app.db')
    const db   = await createClient({ db: path, schema: 'model Note { id Int @id  body String }' }) as any

    // Seeded first, so the table exists before the lock is taken.
    await db.asSystem().note.create({ data: { id: 1, body: 'seed' } })

    await holdWriteLock(path, 250)
    const started = Date.now()
    await db.asSystem().note.create({ data: { id: 2, body: 'after the lock' } })
    const waited = Date.now() - started

    // It waited for the holder rather than failing in a millisecond…
    expect(waited).toBeGreaterThan(150)
    // …and the row is really there.
    expect((await db.asSystem().note.findMany({})).length).toBe(2)
    db.$close()
  })

  test('the LOGGER index — the file every tenant and every process shares', async () => {
    // The one that was missing it, and the one that broke: an audit write from
    // a second process died on `insertIndexRecord` in about a millisecond.
    const dir = tmp()
    const db  = await createClient({
      db:     join(dir, 'app.db'),
      schema: `
        database main  { path "${join(dir, 'app.db')}" }
        database audit { path "${join(dir, 'audit')}/"  driver logger }
        model Note { id Int @id  body String  @@log(audit) }
      `,
    }) as any

    // One write first, so the index database and its table exist to be locked.
    await db.asSystem().note.create({ data: { id: 1, body: 'first' } })
    await new Promise(r => setImmediate(r))   // the logger defers one tick

    // Discovered rather than spelled: the companion index is `<file>.index.db`
    // beside each model's own `.jsonl`, and hardcoding that here would pass
    // against a rename by locking a file nothing uses.
    const indexPath = readdirSync(join(dir, 'audit')).find(f => f.endsWith('.index.db'))
    expect(indexPath).toBeString()
    await holdWriteLock(join(dir, 'audit', indexPath!), 250)

    // The write must SUCCEED. The audit row is fire-and-forget, so a throw
    // inside it is swallowed — asserting the write is what an app would see,
    // and before the fix the process died rather than the row going missing.
    await db.asSystem().note.create({ data: { id: 2, body: 'while the index is locked' } })
    await new Promise(r => setTimeout(r, 400))

    expect((await db.asSystem().note.findMany({})).length).toBe(2)
    db.$close()
  })
})

describe('where the number comes from', () => {
  const ENV = () => globalThis.process.env

  afterEach(() => { delete ENV()[BUSY_TIMEOUT_ENV] })

  test('nothing stated is the default', () => {
    expect(resolveBusyTimeout()).toBe(DEFAULT_BUSY_TIMEOUT_MS)
  })

  test('the env var is read, and an option beats it', () => {
    ENV()[BUSY_TIMEOUT_ENV] = '250'
    expect(resolveBusyTimeout()).toBe(250)      // the CLI, which states nothing
    expect(resolveBusyTimeout(9000)).toBe(9000) // a caller that did
  })

  test('a stated 0 is honored, not treated as absent', () => {
    // `0` is SQLite's own *fail immediately*, and it is a real answer: a test
    // asserting contention wants it, and so does a write that must never block
    // the loop. `??` on a falsy number is how this goes wrong silently.
    ENV()[BUSY_TIMEOUT_ENV] = '5000'
    expect(resolveBusyTimeout(0)).toBe(0)
  })

  test('an unreadable env var is refused rather than ignored', () => {
    // Ignoring it means every connection in the process silently takes the
    // default — which is the failure the variable was set to prevent.
    ENV()[BUSY_TIMEOUT_ENV] = 'thirty seconds'
    expect(() => resolveBusyTimeout()).toThrow(/LITESTONE_BUSY_TIMEOUT/)
  })

  test('a nonsense option is refused by name at createClient time', () => {
    expect(() => validateBusyTimeout(-1)).toThrow(/whole number/)
    expect(() => validateBusyTimeout(1.5)).toThrow(/whole number/)
    expect(() => validateBusyTimeout('5s' as never)).toThrow(/must be a number/)
  })

  test('per-database, and an unknown database name is named', () => {
    const cfg = { default: 5000, audit: 250 }
    expect(validateBusyTimeout(cfg, ['main', 'audit'])).toBe(cfg)
    expect(busyTimeoutFor(cfg, 'audit')).toBe(250)
    expect(busyTimeoutFor(cfg, 'main')).toBe(5000)   // falls to `default`
    expect(busyTimeoutFor(7, 'anything')).toBe(7)
    expect(busyTimeoutFor(null, 'anything')).toBe(null)

    // A dropped key is a database that silently keeps the default, which is
    // the whole class of silence this issue is about.
    expect(() => validateBusyTimeout({ audti: 250 }, ['main', 'audit']))
      .toThrow(/names database 'audti'/)
  })
})

describe('the option reaches the connection', () => {
  test('busyTimeout: 0 on a real client fails at once where the default waits', async () => {
    // End to end, and negative-controlled by the SAME two clients over the same
    // file: asserting the pragma value would pass against an option that never
    // reached `new Database`.
    const path = join(tmp(), 'app.db')

    const eager = await createClient({
      db: path, busyTimeout: 0,
      schema: 'model Note { id Int @id  body String }',
    }) as any
    await eager.asSystem().note.create({ data: { id: 1, body: 'seed' } })

    await holdWriteLock(path, 600)
    const started = Date.now()
    let threw = false
    try { await eager.asSystem().note.create({ data: { id: 2, body: 'nope' } }) }
    catch { threw = true }
    const waited = Date.now() - started
    eager.$close()

    expect(threw).toBe(true)
    expect(waited).toBeLessThan(200)

    // The same write, the same hold, with the default: it waits and commits.
    const patient = await createClient({
      db: path, schema: 'model Note { id Int @id  body String }',
    }) as any
    await holdWriteLock(path, 400)
    await patient.asSystem().note.create({ data: { id: 3, body: 'waited' } })
    expect((await patient.asSystem().note.findMany({})).length).toBe(2)
    patient.$close()
  })

  test('a per-database number reaches the LOGGER index and not main', async () => {
    // The database the issue was filed about: `{ default: 5000, audit: 0 }` is
    // an app saying it would rather drop an audit row than block the loop.
    const dir = tmp()
    const db  = await createClient({
      db:          join(dir, 'app.db'),
      busyTimeout: { default: DEFAULT_BUSY_TIMEOUT_MS, audit: 0 },
      schema: `
        database main  { path "${join(dir, 'app.db')}" }
        database audit { path "${join(dir, 'audit')}/"  driver logger }
        model Note { id Int @id  body String  @@log(audit) }
      `,
    }) as any

    await db.asSystem().note.create({ data: { id: 1, body: 'first' } })
    await new Promise(r => setImmediate(r))

    const indexFile = readdirSync(join(dir, 'audit')).find(f => f.endsWith('.index.db'))!
    await holdWriteLock(join(dir, 'audit', indexFile), 600)

    // The row write still succeeds — main took the default and the audit write
    // is fire-and-forget either way. What is being asserted is that it did not
    // SPEND the default waiting for an index nobody is waiting for.
    const started = Date.now()
    await db.asSystem().note.create({ data: { id: 2, body: 'second' } })
    await new Promise(r => setTimeout(r, 50))
    expect(Date.now() - started).toBeLessThan(500)

    expect((await db.asSystem().note.findMany({})).length).toBe(2)
    db.$close()
  })
})
