// tests/stated-id.test.ts
//
// `dispatch({ id })` — the idempotency `unique` deliberately is not.
//
// A caller that already holds a durable id for the work and cannot confirm
// whether its last handoff landed needs a dispatch that is safe to repeat
// forever. `unique` cannot be that: it frees itself the moment the job is
// terminal, which is exactly when a replay is most likely. The primary key
// can, because it is the one thing in the table that lasts.

import { describe, it, expect, afterEach } from 'bun:test'
import { createCaravan } from '../src/index.ts'
import { openDb, buildStatements, isPrimaryKeyCollision } from '../src/db.ts'
import type { CaravanInstance } from '../src/types.ts'

const queues: CaravanInstance[] = []
afterEach(async () => { for (const q of queues.splice(0)) await q.stop() })

const makeQueue = (): CaravanInstance => {
  const q = createCaravan({ db: ':memory:', pollInterval: 20 })
  queues.push(q)
  return q
}

/** Poll rather than sleep — a fixed sleep passes alone and flakes in the suite. */
async function until(what: string, ok: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (ok()) return
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for: ${what}`)
}

describe('dispatch({ id })', () => {

  it('queues under the stated id', async () => {
    const q  = makeQueue()
    const id = await q.dispatch('send-email', { to: 'a@b.c' }, { id: 'outbox-1' })

    expect(id).toBe('outbox-1')
    expect(q.find('outbox-1')!.name).toBe('send-email')
  })

  it('a second dispatch under the same id queues nothing', async () => {
    const q = makeQueue()
    await q.dispatch('send-email', { to: 'a@b.c' }, { id: 'outbox-1' })
    const again = await q.dispatch('send-email', { to: 'a@b.c' }, { id: 'outbox-1' })

    expect(again).toBe('outbox-1')
    expect(q.list({ limit: 50 }).length).toBe(1)
  })

  it('replays into a no-op after the first job is TERMINAL — where `unique` frees itself', async () => {
    // The distinction this option exists for. A `unique` key is released the
    // moment the job finishes, so the same replay would queue the work twice.
    const q = makeQueue()
    let ran = 0
    q.handle('send-email', async () => { ran++ })
    await q.start()

    await q.dispatch('send-email', {}, { id: 'outbox-1' })
    await until('the first job to finish', () => q.find('outbox-1')?.status === 'done')

    await q.dispatch('send-email', {}, { id: 'outbox-1' })
    await Bun.sleep(100)   // nothing to wait FOR — the claim is that nothing runs

    expect(ran).toBe(1)
    expect(q.list({ limit: 50 }).length).toBe(1)
  })

  it('two dispatches racing on one id still queue once', async () => {
    // Both read nothing before inserting, so the primary key is what decides.
    const q = makeQueue()
    const ids = await Promise.all(
      Array.from({ length: 8 }, () => q.dispatch('send-email', {}, { id: 'outbox-1' }))
    )

    expect(new Set(ids)).toEqual(new Set(['outbox-1']))
    expect(q.list({ limit: 50 }).length).toBe(1)
  })

  it('without a stated id every dispatch is its own job', async () => {
    const q = makeQueue()
    const a = await q.dispatch('send-email', {})
    const b = await q.dispatch('send-email', {})

    expect(a).not.toBe(b)
    expect(q.list({ limit: 50 }).length).toBe(2)
  })
})

describe('the primary key is what decides a race', () => {

  // The in-process path never reaches the catch: dispatch reads and inserts
  // with no await between them, so nothing can interleave. It is the
  // CROSS-PROCESS path — two apps over one jobs.db, both reading before either
  // writes — and what that costs is one SQLite error which has to be told apart
  // from a real failure. Raised here for real rather than described.

  it('recognises a duplicate insert on jobs.id', () => {
    const db    = openDb(':memory:')
    const stmts = buildStatements(db)
    const row = {
      id: 'outbox-1', queue: 'default', name: 'send-email', data: '{}',
      status: 'pending', priority: 0, max_attempts: 3, retry_delay: null,
      unique_key: null, run_at: Date.now(), created_at: Date.now(), actor_id: null, tenant_id: null,
    }

    stmts.insert.run(row)
    let raised: unknown = null
    try { stmts.insert.run(row) } catch (err) { raised = err }

    expect(raised).not.toBeNull()
    expect(isPrimaryKeyCollision(raised)).toBe(true)
    db.close()
  })

  it('does not mistake another failure for one', () => {
    // A NOT NULL breach is the shape this must not swallow: swallowing it would
    // report a job queued that is not there, and the effect never happens.
    const db    = openDb(':memory:')
    const stmts = buildStatements(db)

    let raised: unknown = null
    try {
      stmts.insert.run({
        id: 'outbox-2', queue: 'default', name: 'send-email', data: null,
        status: 'pending', priority: 0, max_attempts: 3, retry_delay: null,
        unique_key: null, run_at: Date.now(), created_at: Date.now(), actor_id: null, tenant_id: null,
      } as never)
    } catch (err) { raised = err }

    expect(raised).not.toBeNull()
    expect(isPrimaryKeyCollision(raised)).toBe(false)
    db.close()
  })
})
