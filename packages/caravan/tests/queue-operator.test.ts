// ============================================================
// Operator verbs on a Queue — pause, resume, drain (FJS-D198).
//
// A pause is a row in jobs.db, so every claim is asked across processes and
// across a restart, and every test here that is about that uses a real FILE:
// `:memory:` is a separate database per instance and agrees with any bug.
//
// Every refusal is PAIRED with the identical call one term away — the unpaused
// queue beside the paused one, the ADMINISTRATOR beside the USER — because a
// mechanism that stopped every queue, or refused every caller, satisfies any
// test that only asks about the refusal.
//
// Traps in this file:
//   • A worker polls on a timer, so "nothing ran" is a claim about an
//     interval. Each one waits several polls AND has a control queue on the
//     same instance proving the poll really happened.
// ============================================================

import { describe, it, expect, afterEach } from 'bun:test'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createTestApp, request } from '@frontierjs/junction'
import { createCaravan } from '../src/index.ts'
import { openDb, buildStatements, aggregateStats } from '../src/db.ts'
import type { CaravanInstance } from '../src/types.ts'

const paths: string[] = []
const live: CaravanInstance[] = []

function tmpPath(): string {
  const p = `${tmpdir()}/caravan-qop-${Math.floor(performance.now() * 1000)}-${process.pid}.db`
  paths.push(p)
  return p
}

function queueAt(path: string, opts: Parameters<typeof createCaravan>[0] = {}): CaravanInstance {
  const c = createCaravan({
    db: path, pollInterval: 15, cleanupAfter: 0,
    queues: { mail: { concurrency: 2 }, reports: { concurrency: 2 } },
    ...opts,
  })
  live.push(c)
  return c
}

async function waitFor(fn: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await Bun.sleep(10)
  }
}

afterEach(async () => {
  for (const c of live.splice(0)) await c.stop().catch(() => {})
  for (const p of paths.splice(0))
    for (const suffix of ['', '-wal', '-shm']) rmSync(p + suffix, { force: true })
})

const statusOf = (c: CaravanInstance, id: string) => c.find(id)?.status

// ─── the claim ────────────────────────────────────────────────────────────────

describe('a paused queue', () => {
  it('claims nothing, while an unpaused queue on the same instance does', async () => {
    const c = queueAt(tmpPath())
    c.handle('send', async () => {}, { queue: 'mail' })
    c.handle('build', async () => {}, { queue: 'reports' })

    c.queue('mail').pause({ actor: 'ops' })
    const held = await c.dispatch('send', {})
    const ran  = await c.dispatch('build', {})
    await c.start()

    await waitFor(() => statusOf(c, ran) === 'done')
    // Several more polls after the control finished, so "still pending" is not
    // just "not reached yet".
    await Bun.sleep(150)
    expect(statusOf(c, held)).toBe('pending')
  })

  it('still QUEUES a dispatch — a pause stops execution, not intake — and runs it on resume', async () => {
    const c = queueAt(tmpPath())
    c.handle('send', async () => {}, { queue: 'mail' })
    await c.start()

    c.queue('mail').pause()
    const id = await c.dispatch('send', {})
    await Bun.sleep(150)
    expect(statusOf(c, id)).toBe('pending')

    c.queue('mail').resume()
    await waitFor(() => statusOf(c, id) === 'done')
  })

  // The reason it is a row. A pause held in memory stops the replica it was
  // issued to and the other one goes on claiming.
  it('is honored by ANOTHER instance on the same file', async () => {
    const path = tmpPath()
    const a = queueAt(path)
    const b = queueAt(path)
    b.handle('send', async () => {}, { queue: 'mail' })
    await b.start()

    a.queue('mail').pause({ actor: 'ops' })
    // The queue is STATED: `a` has no handler for `send`, so an unstated
    // dispatch lands in 'default' — and the pending assertion below then passes
    // against a queue nobody paused.
    const id = await a.dispatch('send', {}, { queue: 'mail' })
    expect(a.find(id)?.queue).toBe('mail')
    await Bun.sleep(150)
    expect(statusOf(a, id)).toBe('pending')

    a.queue('mail').resume({ actor: 'ops' })
    await waitFor(() => statusOf(a, id) === 'done')
  })

  // The case an operator reaches for it in: a crash loop the pause was meant to
  // stop must not lift it on the next boot.
  it('outlives a restart', async () => {
    const path = tmpPath()
    const first = queueAt(path)
    first.queue('mail').pause({ actor: 'ops', reason: 'incident' })
    await first.stop()

    const second = queueAt(path)
    expect(second.queue('mail').state().paused).toMatchObject({ actor: 'ops', reason: 'incident' })
  })

  // The guard is INSIDE the claim statement rather than a check a worker makes
  // first, so the statement itself has to refuse. Asked of the SQL directly,
  // with the same statement against an unpaused queue beside it.
  it('is refused by the claim statement itself, not only by the worker', () => {
    const path = tmpPath()
    const db = openDb(path)
    const st = buildStatements(db)
    const now = Date.now()
    for (const queue of ['mail', 'reports'])
      st.insert.run({
        id: `j-${queue}`, queue, name: 'x', data: '{}', status: 'pending', priority: 0,
        max_attempts: 3, retry_delay: null, unique_key: null, run_at: now - 1, created_at: now,
        actor_id: null, tenant_id: null, correlation_id: null,
      })
    st.pauseQueue.run({ queue: 'mail', at: now, actor: null, reason: null })

    const claim = (queue: string) => st.claimNextNamed(1).get({ queue, now, owner: 'o', n0: 'x' })
    expect(st.anyPending.get({ queue: 'mail', now })).toBeNull()
    expect(claim('mail')).toBeNull()
    expect(st.anyPending.get({ queue: 'reports', now })).not.toBeNull()
    expect(claim('reports')?.id).toBe('j-reports')
    db.close()
  })
})

// ─── drain ────────────────────────────────────────────────────────────────────

describe('drain', () => {
  it('waits for the job already running, and leaves the queue paused', async () => {
    const c = queueAt(tmpPath())
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    c.handle('slow', async () => { await gate }, { queue: 'mail' })
    await c.start()

    const id = await c.dispatch('slow', {})
    await waitFor(() => statusOf(c, id) === 'running')

    const draining = c.queue('mail').drain({ actor: 'ops', timeout: 3_000 })
    await Bun.sleep(100)
    release()
    const out = await draining

    expect(out).toMatchObject({ drained: true, running: 0 })
    expect(statusOf(c, id)).toBe('done')
    expect(c.queue('mail').state().paused).not.toBeNull()
  })

  // The pair. A drain that answered `drained` without waiting satisfies the row
  // above whenever the job happens to be quick.
  it('answers drained: false with the count when the timeout comes first, rather than throwing', async () => {
    const c = queueAt(tmpPath())
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    c.handle('slow', async () => { await gate }, { queue: 'mail' })
    await c.start()

    const id = await c.dispatch('slow', {})
    await waitFor(() => statusOf(c, id) === 'running')

    const out = await c.queue('mail').drain({ timeout: 120 })
    expect(out).toMatchObject({ drained: false, running: 1 })
    release()
  })

  // A drain that waited on its own workers would call a queue quiet while
  // another replica is midway through a job in it.
  it("counts ANOTHER instance's running job", async () => {
    const path = tmpPath()
    const worker   = queueAt(path)
    const operator = queueAt(path)
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    worker.handle('slow', async () => { await gate }, { queue: 'mail' })
    await worker.start()

    const id = await operator.dispatch('slow', {}, { queue: 'mail' })
    await waitFor(() => statusOf(operator, id) === 'running')

    expect(await operator.queue('mail').drain({ timeout: 120 })).toMatchObject({ drained: false, running: 1 })
    release()
    await waitFor(() => statusOf(operator, id) === 'done')
    expect(await operator.queue('mail').drain({ timeout: 500 })).toMatchObject({ drained: true, running: 0 })
  })
})

// ─── what the second person is told ──────────────────────────────────────────

describe('a verb that changes nothing', () => {
  it('a pause over a pause names who is already holding it and records nothing', () => {
    const c = queueAt(tmpPath())
    expect(c.queue('mail').pause({ actor: 'alice', reason: 'migration' }).changed).toBe(true)

    const second = c.queue('mail').pause({ actor: 'bob' })
    expect(second.changed).toBe(false)
    expect(second.pause).toMatchObject({ actor: 'alice', reason: 'migration' })
    expect(c.queue('mail').state().events.map(e => e.verb)).toEqual(['pause'])
  })

  it('a resume of a queue nobody paused records nothing', () => {
    const c = queueAt(tmpPath())
    expect(c.queue('mail').resume({ actor: 'bob' }).changed).toBe(false)
    expect(c.queue('mail').state().events).toEqual([])
  })
})

// ─── the audit ────────────────────────────────────────────────────────────────

describe('queue_events', () => {
  it('keeps who paused, who resumed and what the drain found, after the pause row is gone', async () => {
    const c = queueAt(tmpPath())
    await c.start()
    c.queue('mail').pause({ actor: 'alice', reason: 'migration' })
    await Bun.sleep(2)
    c.queue('mail').resume({ actor: 'bob' })
    await Bun.sleep(2)
    await c.queue('mail').drain({ actor: 'carol', timeout: 50 })

    const events = c.queue('mail').state().events
    expect(events.map(e => [e.verb, e.actor])).toEqual([['drain', 'carol'], ['pause', 'carol'], ['resume', 'bob'], ['pause', 'alice']])
    expect(events.find(e => e.actor === 'alice')!.detail).toEqual({ reason: 'migration' })
    // The resume carries the pause it lifted — the row that said so is deleted.
    expect(events.find(e => e.verb === 'resume')!.detail).toMatchObject({ pausedBy: 'alice' })
    expect(events.find(e => e.verb === 'drain')!.detail).toMatchObject({ drained: true, running: 0 })
  })
})

// ─── the name ─────────────────────────────────────────────────────────────────

describe('queue(name)', () => {
  it('refuses a name nothing declared, and lists the ones that exist', () => {
    const c = queueAt(tmpPath())
    expect(() => c.queue('mial')).toThrow(/no queue named 'mial'.*mail/)
  })

  // A web process knows only its own configuration. The worker process's queue
  // is in the DATA, and a pause issued from the web process must still find it.
  it('finds a queue only the data names — another process declared it', async () => {
    const path = tmpPath()
    const worker = queueAt(path, { queues: { invoices: { concurrency: 1 } } })
    await worker.dispatch('bill', {}, { queue: 'invoices' })

    const web = queueAt(path, { queues: {} })
    expect(() => web.queue('invoices')).not.toThrow()
    expect(web.queue('invoices').pause({ actor: 'ops' }).changed).toBe(true)
  })

  it('does not create the queue it was asked about', () => {
    const c = queueAt(tmpPath())
    expect(() => c.queue('ghost')).toThrow()
    expect(Object.keys(c.stats().queues)).not.toContain('ghost')
  })
})

// ─── stats ────────────────────────────────────────────────────────────────────

describe('stats()', () => {
  it('tells a paused queue from an idle one, which the counts alone cannot', () => {
    const c = queueAt(tmpPath())
    c.queue('mail').pause()

    const { mail, reports } = c.stats().queues
    const counts = ({ pausedMs: _p, ...rest }: typeof mail) => rest
    expect(counts(mail)).toEqual(counts(reports))
    expect(mail.pausedMs).toBeGreaterThanOrEqual(0)
    expect(reports.pausedMs).toBeNull()
  })

  it('reports the age of the longest pause as the total', () => {
    const now = 1_000_000
    const s = aggregateStats([], ['a', 'b'], [], now, [
      { queue: 'a', paused_at: now - 5_000 },
      { queue: 'b', paused_at: now - 90_000 },
    ])
    expect(s.queues.a.pausedMs).toBe(5_000)
    expect(s.total.pausedMs).toBe(90_000)
  })
})

// ─── over HTTP ────────────────────────────────────────────────────────────────

describe('the operator routes', () => {
  const users = [
    { id: 'ops',   isAdmin: true },
    { id: 'staff', role: 'user' },
  ]

  async function appWith() {
    const app = await createTestApp({ users })
    app.configure(createCaravan({ db: ':memory:', pollInterval: 10, admin: true, queues: { mail: {} } }))
    return app
  }

  const jobsOf = (app: { jobs?: unknown }) => app.jobs as CaravanInstance

  it('refuse a caller with no session, even where the admin surface is open', async () => {
    const app = await appWith()
    // The read is the admin surface's ordinary tier and this configuration
    // leaves it open, which is what makes the refusal below about the VERB.
    expect((await request(app).get('/jobs/queues')).status).toBe(200)
    expect((await request(app).post('/jobs/queues/mail/pause')).status).toBe(401)
  })

  it('refuse a USER by naming the standing it needs', async () => {
    const app = await appWith()
    const res = await request(app).post('/jobs/queues/mail/pause').auth('test-token-staff')
    expect(res.status).toBe(403)
    expect(JSON.stringify(res.body)).toContain('ADMINISTRATOR')
    expect(jobsOf(app).queue('mail').state().paused).toBeNull()
  })

  it('accept an ADMINISTRATOR, and record them as the one holding it', async () => {
    const app = await appWith()
    const res = await request(app).post('/jobs/queues/mail/pause').auth('test-token-ops').send({ reason: 'deploy' })
    expect(res.status).toBe(200)
    expect(jobsOf(app).queue('mail').state().paused).toMatchObject({ actor: 'ops', reason: 'deploy' })

    const back = await request(app).post('/jobs/queues/mail/resume').auth('test-token-ops')
    expect(back.status).toBe(200)
    expect(jobsOf(app).queue('mail').state().paused).toBeNull()
  })

  it('answer 404 naming the queues for a name nothing declared', async () => {
    const app = await appWith()
    const res = await request(app).post('/jobs/queues/mial/pause').auth('test-token-ops')
    expect(res.status).toBe(404)
    expect(JSON.stringify(res.body)).toContain('mail')
  })

  // `GET {base}/{id}` is registered too; `queues` must not be read as a job id.
  it('serve the queue list, not a job called "queues"', async () => {
    const app = await appWith()
    const res = await request(app).get('/jobs/queues')
    expect(res.status).toBe(200)
    expect((res.body as Array<{ name: string }>).map(q => q.name)).toContain('mail')
  })
})
