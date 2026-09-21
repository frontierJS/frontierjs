// ============================================================
// The seven defects an audit of this package found, each asserted through the
// entry point that produced it. Four of them are only reachable from more than
// one process, so those spawn real `bun` subprocesses against a real file: a
// cold-start lock, a unique-key race and a claim by a process with no handler
// are all things a single in-process test agrees with itself about.
//
// FJS-674 admin · FJS-675 no-handler claim · FJS-676 cold start · FJS-695
// synchronous · FJS-696 re-poll · FJS-697 timers and stop() · FJS-699 unique.
// ============================================================

import { describe, it, expect, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createTestApp, request } from '@frontierjs/junction'
import { createCaravan } from '../src/index.ts'
import { openDb } from '../src/db.ts'
import type { CaravanInstance } from '../src/types.ts'

const SRC = resolve(import.meta.dir, '../src/index.ts')
const dirs: string[] = []

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'caravan-hardening-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

// A script run in its own process. `bun` rather than a Worker: the failures
// below are about two OS processes on one SQLite file.
async function spawnScript(dir: string, name: string, source: string, args: string[] = []) {
  const file = join(dir, name)
  writeFileSync(file, source)
  const proc = Bun.spawn(['bun', file, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { out: out.trim(), err: err.trim(), code: await proc.exited }
}

const jobsOf = (app: { jobs?: CaravanInstance }) => app.jobs!

// ─── FJS-674 — the admin surface is remote job execution ─────────────────────

describe('FJS-674 — admin routes in production', () => {
  const prod = <T>(fn: () => Promise<T>): Promise<T> => {
    const was = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    return fn().finally(() => {
      if (was === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = was
    })
  }

  it('are NOT mounted in production without an authorizer', async () => {
    await prod(async () => {
      const app = await createTestApp()
      app.configure(createCaravan({ db: ':memory:', pollInterval: 10, admin: true }))
      await jobsOf(app).dispatch('report', {})

      // The measured failure was a stranger reading the whole table and
      // POSTing a handler into execution as the app itself.
      expect((await request(app).get('/jobs')).status).toBe(404)
    })
  })

  it('refuse a `secret` in production — it is a development shortcut', async () => {
    await prod(async () => {
      const app = await createTestApp()
      app.configure(createCaravan({ db: ':memory:', pollInterval: 10, admin: { secret: 's3cret' } }))
      expect((await request(app).get('/jobs')).status).toBe(404)
    })
  })

  it('mount in production behind an authorizer, which decides per request', async () => {
    await prod(async () => {
      const app = await createTestApp()
      app.configure(createCaravan({
        db: ':memory:', pollInterval: 10,
        admin: { authorize: (ctx) => (ctx as { headers?: Record<string, string> }).headers?.['x-ops'] === 'yes' },
      }))
      await jobsOf(app).dispatch('report', {})

      expect((await request(app).get('/jobs')).status).toBe(401)
      const ok = await request(app).get('/jobs').set('x-ops', 'yes')
      expect(ok.status).toBe(200)
    })
  })

  it('redact every payload in the list unless it is asked for by name', async () => {
    const app = await createTestApp()
    app.configure(createCaravan({ db: ':memory:', pollInterval: 10, admin: true }))
    await jobsOf(app).dispatch('reset', { token: 'super-secret-reset-token' })

    const hidden = await request(app).get('/jobs')
    expect(JSON.stringify(hidden.body)).not.toContain('super-secret-reset-token')
    expect((hidden.body as Array<{ data: string }>)[0].data).toBe('[redacted]')

    const shown = await request(app).get('/jobs?data=1')
    expect(JSON.stringify(shown.body)).toContain('super-secret-reset-token')
  })

  it('answer 401 to a wrong secret and 200 to the right one', async () => {
    const app = await createTestApp()
    app.configure(createCaravan({ db: ':memory:', pollInterval: 10, admin: { secret: 'abcdef' } }))
    expect((await request(app).get('/jobs').set('x-caravan-secret', 'abcdez')).status).toBe(401)
    // A different LENGTH must not throw out of timingSafeEqual.
    expect((await request(app).get('/jobs').set('x-caravan-secret', 'ab')).status).toBe(401)
    expect((await request(app).get('/jobs').set('x-caravan-secret', 'abcdef')).status).toBe(200)
  })
})

// ─── FJS-675 — a process with no handler must not destroy the work ──────────

describe('FJS-675 — a claim a process cannot execute', () => {
  it('leaves the job for the process that has the handler', async () => {
    const dir = scratch()
    const db  = join(dir, 'jobs.db')

    // The measured shape: a web process with no handler polls 400ms before the
    // worker starts, and every job is `failed "No handler registered"`.
    const web = createCaravan({ db, pollInterval: 20, cleanupAfter: 0 })
    await web.start()
    const ids: string[] = []
    for (let i = 0; i < 5; i++) ids.push(await web.dispatch('send-email', { i }, { queue: 'email' }))
    await Bun.sleep(300)

    expect(web.stats().total.failed).toBe(0)
    for (const id of ids) expect(web.find(id)!.status).toBe('pending')

    let ran = 0
    const worker = createCaravan({ db, pollInterval: 20, cleanupAfter: 0 })
    worker.handle('send-email', async () => { ran++ }, { queue: 'email' })
    await worker.start()
    await Bun.sleep(600)
    expect(ran).toBe(5)

    await web.stop()
    await worker.stop()
  })

  it('consumes no attempt when it releases one it claimed anyway', async () => {
    const dir = scratch()
    const db  = join(dir, 'jobs.db')
    const q   = createCaravan({ db, pollInterval: 20, cleanupAfter: 0 })
    // A handler on the queue, so the claim filter admits a poll; the job's own
    // name has none, which is the backstop path.
    q.handle('other', async () => {})
    await q.start()
    const raw = new Database(db)
    const id  = crypto.randomUUID()
    raw.query(
      `INSERT INTO jobs (id, queue, name, data, status, priority, max_attempts, run_at, created_at)
       VALUES (?, 'default', 'ghost', '{}', 'pending', 0, 3, ?, ?)`
    ).run(id, Date.now(), Date.now())
    await Bun.sleep(200)

    const row = q.find(id)!
    expect(row.status).toBe('pending')
    expect(row.attempts).toBe(0)
    await q.stop()
  })
})

// ─── FJS-676 — four processes opening a jobs.db that does not exist yet ─────

describe('FJS-676 — concurrent cold start', () => {
  it('does not throw on PRAGMA journal_mode', async () => {
    const dir = scratch()
    const db  = join(dir, 'jobs.db')
    const script = `
const { createCaravan } = await import(${JSON.stringify(SRC)})
const q = createCaravan({ db: ${JSON.stringify(db)}, cleanupAfter: 0 })
// Line the four processes up on the same instant — the race is the moment the
// file is created, and a stagger hides it entirely.
const at = Number(process.argv[3])
while (Date.now() < at) {}
try { await q.start(); console.log('ok'); await q.stop() }
catch (e) { console.log('THREW ' + e.message) }
`
    let threw = 0, runs = 0
    for (let round = 0; round < 3; round++) {
      for (const s of ['', '-wal', '-shm']) rmSync(db + s, { force: true })
      const at = Date.now() + 700
      const outs = await Promise.all(
        ['A', 'B', 'C', 'D'].map(r => spawnScript(dir, `cold-${round}-${r}.ts`, script, [r, String(at)]))
      )
      for (const o of outs) { runs++; if (!o.out.includes('ok')) { threw++; console.log(o.out || o.err) } }
    }
    expect([threw, runs]).toEqual([0, 12])
  }, 60_000)
})

// ─── FJS-695 — the fsync per row ────────────────────────────────────────────

describe('FJS-695 — synchronous', () => {
  // Asked of the connection that set it: `PRAGMA synchronous` is per
  // connection, so a second Database over the same file answers its own
  // default and would report FULL however this opened.
  it('opens NORMAL by default and FULL when asked', () => {
    const dir = scratch()
    const read = (opt?: 'NORMAL' | 'FULL') => {
      const db = openDb(join(dir, `${opt ?? 'default'}.db`), 5_000, opt)
      const row = db.query<{ synchronous: number }, []>('PRAGMA synchronous').get()
      db.close()
      return row!.synchronous
    }
    expect(read()).toBe(1)        // NORMAL
    expect(read('NORMAL')).toBe(1)
    expect(read('FULL')).toBe(2)
  })

  it('is the pragma a caravan opens its database with', async () => {
    const dir = scratch()
    // Read off the statements the queue's own connection runs: the pragma is
    // per connection, so a second Database over the file answers its default.
    const script = `
import { Database } from 'bun:sqlite'
const seen = []
const exec = Database.prototype.exec
Database.prototype.exec = function (sql, ...r) { seen.push(String(sql)); return exec.call(this, sql, ...r) }
const { createCaravan } = await import(${JSON.stringify(SRC)})
const q = createCaravan({ db: ${JSON.stringify(join(dir, 'jobs.db'))}, cleanupAfter: 0 })
await q.dispatch('x', {})
console.log(JSON.stringify(seen.filter(s => /synchronous/i.test(s))))
await q.stop()
`
    const r = await spawnScript(dir, 'sync.ts', script)
    expect(JSON.parse(r.out.split('\n')[0])).toEqual(['PRAGMA synchronous = NORMAL'])
  }, 20_000)
})

// ─── FJS-696 — throughput was concurrency / pollInterval ────────────────────

describe('FJS-696 — a finished job claims the next one', () => {
  it('drains 100 jobs at a 1s poll in well under 5s', async () => {
    const dir = scratch()
    const q = createCaravan({
      db: join(dir, 'jobs.db'), pollInterval: 1_000, cleanupAfter: 0,
      queues: { default: { concurrency: 2 } },
    })
    let ran = 0
    q.handle('noop', async () => { ran++ })
    for (let i = 0; i < 100; i++) await q.dispatch('noop', { i })
    const t0 = Date.now()
    await q.start()
    while (ran < 100 && Date.now() - t0 < 20_000) await Bun.sleep(10)
    const elapsed = Date.now() - t0
    await q.stop()
    // Sleeping a whole interval with capacity free took 50s for this run.
    expect(ran).toBe(100)
    expect(elapsed).toBeLessThan(5_000)
  }, 30_000)
})

// ─── FJS-697 — idle cost, a timer that throws, and stop() under a handler ───

describe('FJS-697 — timers and shutdown', () => {
  it('takes no write lock while three queues are idle', async () => {
    const dir = scratch()
    // Counted rather than inferred: an empty `BEGIN IMMEDIATE` commits nothing,
    // so the file does not move and every after-the-fact probe agrees with a
    // queue taking a write lock 3 times a second on one shared file.
    const script = `
import { Database } from 'bun:sqlite'
let begins = 0
const exec = Database.prototype.exec
Database.prototype.exec = function (sql, ...r) { if (String(sql) === 'BEGIN IMMEDIATE') begins++; return exec.call(this, sql, ...r) }
const { createCaravan } = await import(${JSON.stringify(SRC)})
const q = createCaravan({
  db: ${JSON.stringify(join(dir, 'jobs.db'))}, pollInterval: 50, cleanupAfter: 0,
  heartbeat: 60000, queues: { email: {}, sms: {} },
})
q.handle('noop', async () => {})
q.handle('noop-email', async () => {}, { queue: 'email' })
q.handle('noop-sms', async () => {}, { queue: 'sms' })
await q.start()
await Bun.sleep(100)
begins = 0
await Bun.sleep(1500)   // ~90 polls across 3 queues
console.log(String(begins))
await q.stop()
`
    const r = await spawnScript(dir, 'idle.ts', script)
    expect(Number(r.out.split('\n')[0])).toBe(0)
  }, 30_000)

  it('survives a timer callback that throws', async () => {
    const dir = scratch()
    const q = createCaravan({ db: join(dir, 'jobs.db'), pollInterval: 50, cleanupAfter: 0, heartbeat: 20 })
    await q.start()
    // A sweep against a handle that is gone used to be an uncaughtException
    // out of setInterval, taking the process with it — and the heartbeat it
    // missed is what makes another instance reclaim this one's rows.
    const raw = new Database(join(dir, 'jobs.db'))
    raw.exec('PRAGMA busy_timeout = 0')
    raw.exec('BEGIN IMMEDIATE')
    await Bun.sleep(300)
    raw.exec('COMMIT')
    expect(q.stats().total.pending).toBe(0)
    await q.stop()
  })

  it('stop() under a running handler raises no unhandled rejection and leaves no timer', async () => {
    const dir = scratch()
    const db  = join(dir, 'jobs.db')
    const script = `
process.on('unhandledRejection', (e) => console.log('UNHANDLED ' + (e && e.message)))
const { createCaravan } = await import(${JSON.stringify(SRC)})
const q = createCaravan({ db: ${JSON.stringify(db)}, pollInterval: 20, cleanupAfter: 1000, drainTimeout: 200 })
q.handle('long', async () => { await Bun.sleep(1000) })
await q.start()
await q.dispatch('long', {})
await Bun.sleep(300)
await q.stop()
// Past the abandoned handler's own completion, which is where the write lands.
await Bun.sleep(1200)
console.log('DONE')
`
    const r = await spawnScript(dir, 'stop.ts', script)
    expect(r.out).toContain('DONE')
    expect(r.out).not.toContain('UNHANDLED')
    expect(r.err).not.toContain('Database has closed')
    // The hourly sweep used to keep the loop alive and fire against a closed
    // handle; nothing unref'd can be asserted except by the process ending.
    expect(r.code).toBe(0)
  }, 30_000)
})

// ─── FJS-699 — two processes racing one unique key ──────────────────────────

describe('FJS-699 — dispatch({ unique }) under a cross-process race', () => {
  it('answers the winner\'s id rather than throwing', async () => {
    const dir = scratch()
    const db  = join(dir, 'jobs.db')
    const script = `
const { createCaravan } = await import(${JSON.stringify(SRC)})
const q = createCaravan({ db: ${JSON.stringify(db)}, cleanupAfter: 0 })
const at = Number(process.argv[3])
while (Date.now() < at) {}
let ok = 0, threw = 0, msg = ''
const ids = new Set()
for (let i = 0; i < 300; i++) {
  try { ids.add(await q.dispatch('job', {}, { unique: 'one-key' })); ok++ }
  catch (e) { threw++; msg = e.message }
}
console.log(JSON.stringify({ ok, threw, msg, ids: [...ids] }))
`
    const at = Date.now() + 900
    const outs = await Promise.all(
      ['A', 'B', 'C'].map(r => spawnScript(dir, `unique-${r}.ts`, script, [r, String(at)]))
    )
    const results = outs.map(o => JSON.parse(o.out.split('\n').pop()!))
    for (const r of results) expect([r.threw, r.msg]).toEqual([0, ''])
    for (const r of results) expect(r.ok).toBe(300)

    const rows = new Database(db).query('SELECT id FROM jobs').all() as { id: string }[]
    expect(rows).toHaveLength(1)
    // Every process was told the same id — the one job doing the work.
    const seen = new Set(results.flatMap((r: { ids: string[] }) => r.ids))
    expect([...seen]).toEqual([rows[0].id])
  }, 60_000)
})
