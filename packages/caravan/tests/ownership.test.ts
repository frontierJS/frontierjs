// tests/ownership.test.ts
// Two Caravan instances on ONE jobs.db — the shape nothing in this package
// used to state, test or enforce (FJS-294).
//
// A file database is trivially opened twice: two replicas behind a load
// balancer, a web process beside a worker one, a drive started while the dev
// server runs. Both halves of the old behaviour are measured here as the thing
// they must no longer do — a cron declared in both firing twice a tick, and a
// second start() releasing the row the first instance was midway through.
//
// Traps in this file:
//   • `:memory:` is a different database per instance, so every test here needs
//     a real file — the bug is invisible in memory.
//   • The cron assertion straddles a minute boundary about once in a thousand
//     runs, so it reads the minute either side and only asserts when they agree.

import { describe, it, expect, afterEach } from 'bun:test'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Database } from 'bun:sqlite'
import { createCaravan } from '../src/index.ts'
import { openDb, buildStatements } from '../src/db.ts'
import type { CaravanInstance } from '../src/types.ts'

const paths: string[] = []

function tmpPath(): string {
  const p = `${tmpdir()}/caravan-own-${Math.floor(performance.now() * 1000)}-${process.pid}.db`
  paths.push(p)
  return p
}

function makeQueue(path: string, opts: Parameters<typeof createCaravan>[0] = {}): CaravanInstance {
  return createCaravan({ db: path, pollInterval: 20, cleanupAfter: 0, ...opts })
}

async function waitFor(fn: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await Bun.sleep(10)
  }
}

afterEach(() => {
  for (const p of paths.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) rmSync(p + suffix, { force: true })
  }
})

// ─── Cron ─────────────────────────────────────────────────────────────────────

describe('two instances, one cron', () => {

  it('fire the same minute once, not once each', async () => {
    const path = tmpPath()
    const before = Math.floor(Date.now() / 60_000)

    const a = makeQueue(path)
    const b = makeQueue(path)
    a.handle('tick', async () => {}, { cron: '* * * * *' })
    b.handle('tick', async () => {}, { cron: '* * * * *' })

    // start() ticks the scheduler immediately, so both fire now.
    await a.start()
    await b.start()
    await Bun.sleep(100)

    const after = Math.floor(Date.now() / 60_000)
    const rows  = a.list({ limit: 100 }).filter(j => j.name === 'tick')

    // Two fires in one minute is the defect; two fires either side of a minute
    // boundary is the schedule doing its job.
    if (before === after) expect(rows.length).toBe(1)
    else                  expect(rows.length).toBeLessThanOrEqual(2)

    await a.stop()
    await b.stop()
  })

  it('names the fire by job and minute, so the id itself is the dedup', async () => {
    const path = tmpPath()
    const a = makeQueue(path)
    a.handle('tick', async () => {}, { cron: '* * * * *' })
    await a.start()
    await Bun.sleep(100)

    const row = a.list({ limit: 10 }).find(j => j.name === 'tick')
    expect(row?.id).toMatch(/^cron:tick:\d+$/)

    await a.stop()
  })

})

// ─── Recovery ─────────────────────────────────────────────────────────────────

describe('recovery across instances', () => {

  it('a second start() does not re-run the job the first is executing', async () => {
    const path = tmpPath()
    let   runs = 0

    const handler = async () => { runs++; await Bun.sleep(400) }

    const a = makeQueue(path)
    a.handle('slow', handler)
    await a.start()

    const id = await a.dispatch('slow', {})
    await waitFor(() => a.find(id)?.status === 'running')

    // The second replica comes up mid-flight. Its start() used to set every
    // running row back to pending, and its worker then claimed this one.
    const b = makeQueue(path)
    b.handle('slow', handler)
    await b.start()

    await waitFor(() => a.find(id)?.status === 'done')
    await Bun.sleep(200)

    expect(runs).toBe(1)
    expect(a.find(id)!.attempts).toBe(1)

    await a.stop()
    await b.stop()
  })

  it('reclaims a running row whose owner never heartbeated — a crashed process', async () => {
    const path = tmpPath()

    // A crashed instance leaves a running row behind and no owner saying it is
    // alive. Written by hand because the only other way to make one is to kill
    // a process mid-job.
    const raw   = openDb(path)
    const stmts = buildStatements(raw)
    stmts.insert.run({
      id: 'orphan', queue: 'default', name: 'work', data: '{}', status: 'pending',
      priority: 0, max_attempts: 3, retry_delay: null, unique_key: null,
      run_at: Date.now(), created_at: Date.now(), actor_id: null,
    })
    raw.exec(`UPDATE jobs SET status = 'running', owner_id = 'ghost' WHERE id = 'orphan'`)
    raw.close()

    let ran = false
    const q = makeQueue(path)
    q.handle('work', async () => { ran = true })
    await q.start()

    await waitFor(() => ran)
    expect(q.find('orphan')!.status).toBe('done')

    await q.stop()
  })

  it('reclaims a running row whose owner went quiet past the lease', async () => {
    const path = tmpPath()
    const raw  = openDb(path)
    const stmts = buildStatements(raw)
    stmts.insert.run({
      id: 'stalled', queue: 'default', name: 'work', data: '{}', status: 'pending',
      priority: 0, max_attempts: 3, retry_delay: null, unique_key: null,
      run_at: Date.now(), created_at: Date.now(), actor_id: null,
    })
    raw.exec(`UPDATE jobs SET status = 'running', owner_id = 'gone' WHERE id = 'stalled'`)
    // Last said it was alive a minute ago; the default lease is 30s.
    raw.exec(`INSERT INTO job_owners (id, started_at, seen_at) VALUES ('gone', 0, ${Date.now() - 60_000})`)
    raw.close()

    let ran = false
    const q = makeQueue(path)
    q.handle('work', async () => { ran = true })
    await q.start()

    await waitFor(() => ran)
    await q.stop()
  })

  it('leaves alone a running row whose owner is still heartbeating', async () => {
    const path = tmpPath()
    const raw  = openDb(path)
    const stmts = buildStatements(raw)
    stmts.insert.run({
      id: 'held', queue: 'default', name: 'work', data: '{}', status: 'pending',
      priority: 0, max_attempts: 3, retry_delay: null, unique_key: null,
      run_at: Date.now(), created_at: Date.now(), actor_id: null,
    })
    raw.exec(`UPDATE jobs SET status = 'running', owner_id = 'alive' WHERE id = 'held'`)
    raw.exec(`INSERT INTO job_owners (id, started_at, seen_at) VALUES ('alive', 0, ${Date.now()})`)
    raw.close()

    let ran = false
    const q = makeQueue(path)
    q.handle('work', async () => { ran = true })
    await q.start()
    await Bun.sleep(300)

    expect(ran).toBe(false)
    expect(q.find('held')!.status).toBe('running')

    await q.stop()
  })

  it('gives its rows back on a clean stop rather than holding them for a lease', async () => {
    const path = tmpPath()
    const a = makeQueue(path)
    a.handle('work', async () => {})
    await a.start()
    await a.stop()

    const db    = new Database(path)
    const rows  = db.query<{ n: number }, []>(`SELECT COUNT(*) as n FROM job_owners`).get()
    db.close()
    expect(rows!.n).toBe(0)
  })

})

// ─── The completion guard ─────────────────────────────────────────────────────

describe('a completion belongs to the instance that claimed it', () => {

  it('markDone by anyone but the owner changes nothing', () => {
    const path  = tmpPath()
    const db    = openDb(path)
    const stmts = buildStatements(db)

    stmts.insert.run({
      id: 'j1', queue: 'default', name: 'work', data: '{}', status: 'pending',
      priority: 0, max_attempts: 3, retry_delay: null, unique_key: null,
      run_at: Date.now(), created_at: Date.now(), actor_id: null,
    })
    stmts.claimNext.get({ queue: 'default', now: Date.now(), owner: 'A' })

    // B reclaimed and re-ran the row; A's late completion must not land on it.
    expect(stmts.markDone.run({ id: 'j1', now: Date.now(), owner: 'B' }).changes).toBe(0)
    expect(stmts.markDone.run({ id: 'j1', now: Date.now(), owner: 'A' }).changes).toBe(1)
    // Done rows own nothing, so a sweep has nothing to decide about them.
    expect(stmts.getById.get({ id: 'j1' })!.owner_id).toBe(null)

    db.close()
  })

})
