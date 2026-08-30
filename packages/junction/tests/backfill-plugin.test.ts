// tests/backfill-plugin.test.ts
//
// The loop: boot kicks the first chunk, a chunk kicks the next after the duty
// cycle, and the chain ends when the scan comes back short.
//
// The QUEUE is a recording dispatcher and is not a simulation of one — it
// records the calls the plugin makes and runs the handler, which is what tests
// this plugin's loop. **That a real queue drives a backfill to completion is not
// proven here**, for the reason `outbox.test.ts` gives about delivery: junction
// takes caravan as neither a dependency nor a devDependency, so there is no
// queue to hand a chunk to. Its durability, retries and `dispatch({ id })`
// idempotence are caravan's own, tested there.
//
// The database is real, because everything the loop reads back is a row.

import { describe, test, expect } from 'bun:test'

import { createClient }  from '../../litestone/src/index.js'
import { backfills }     from '../src/plugins/backfill/index.ts'
import { defineBackfill, BACKFILL_JOB } from '../src/core/backfill.ts'

const BACKFILL = await Bun.file(new URL('../db/backfill.lite', import.meta.url)).text()

const SCHEMA = `
database main { path "./app.db" }

model Order {
  id        Int       @id @default(autoincrement())
  reference String
  shippedAt DateTime?
  @@db(main)
}

${BACKFILL}
`

/** Records what the plugin asked the queue to do, and runs the handler. */
function recorder() {
  const handlers = new Map<string, (ctx: { data: any }) => Promise<void>>()
  const sent: Array<{ name: string; data: any; opts: any }> = []
  const seenIds = new Set<string>()

  return {
    sent,
    jobs: {
      handle(name: string, fn: (ctx: { data: any }) => Promise<void>) { handlers.set(name, fn) },
      async dispatch(name: string, data: any, opts: any) {
        // The one piece of the queue's contract this stands in for, because the
        // plugin's own correctness depends on it: a dispatch under an id already
        // taken is a no-op. Caravan's, tested in caravan.
        if (opts?.id && seenIds.has(opts.id)) return opts.id
        if (opts?.id) seenIds.add(opts.id)
        sent.push({ name, data, opts })
        return opts?.id ?? 'x'
      },
    },
    /** Drain the queue the way a worker would, in order. */
    async drain(limit = 50) {
      for (let i = 0; i < limit; i++) {
        const next = sent.shift()
        if (!next) return
        await handlers.get(next.name)?.({ data: next.data })
      }
    },
    hasHandler: (name: string) => handlers.has(name),
  }
}

async function mkApp(defs: any[], opts: any = {}) {
  const db  = await createClient({ databases: ':memory:', schema: SCHEMA }) as any
  const rec = recorder()
  const claimed: Record<string, unknown> = {}
  const metrics: Record<string, () => unknown> = {}

  const app: any = {
    db, jobs: rec.jobs, logger: { error() {} },
    claim: (k: string, v: unknown) => { claimed[k] = v },
    registerMetricsSource: (k: string, fn: () => unknown) => { metrics[k] = fn },
  }
  const plugin = backfills(defs, { autoStart: true, intervalMs: 10_000, ...opts })
  plugin.register!(app)
  return { app, db, rec, plugin, api: () => claimed.backfills as any, metrics }
}

const ship = (over: Record<string, unknown> = {}) => defineBackfill({
  name: 'ship', model: 'Order', field: 'shippedAt', chunkSize: 5, duty: 0.5,
  fill: () => new Date('2026-01-01T00:00:00.000Z'),
  ...over,
} as never)

const seed = async (db: any, n: number) => {
  for (let i = 1; i <= n; i++) await db.asSystem().order.create({ data: { reference: `ORD-${i}` } })
}

// ─── construction ────────────────────────────────────────────────────────────

describe('backfills()', () => {
  test('refuses anything that did not come from defineBackfill', () => {
    expect(() => backfills([{ name: 'x', model: 'Order', field: 'y' } as never]))
      .toThrow(/must come from defineBackfill/)
  })

  // A name is a row's primary key, so two definitions sharing one are two
  // backfills writing each other's position.
  test('refuses two definitions with one name', () => {
    expect(() => backfills([ship(), ship()])).toThrow(/two definitions named 'ship'/)
  })

  test('claims app.backfills and contributes a metrics source', async () => {
    const { api, metrics } = await mkApp([ship()])
    expect(typeof api().status).toBe('function')
    expect(typeof metrics.backfills).toBe('function')
  })

  test('an undeclared name is refused by the api, and says what it was given', async () => {
    const { api } = await mkApp([ship()])
    await expect(api().start('nope')).rejects.toThrow(/is not declared.*'ship'/s)
  })
})

// ─── boot ────────────────────────────────────────────────────────────────────

describe('boot', () => {
  test('refuses a schema with no BackfillRun, and says how to fix it', async () => {
    const db = await createClient({
      databases: ':memory:',
      schema: 'database main { path "./a.db" }\nmodel Order { id Int @id @default(autoincrement())\n shippedAt DateTime?\n @@db(main) }',
    }) as any
    const plugin = backfills([ship()])
    plugin.register!({ db, claim() {} } as never)
    await expect(plugin.boot!({ db, jobs: { handle() {} } } as never))
      .rejects.toThrow(/declares no BackfillRun.*fli backfill:install/s)
  })

  test('registers one handler for every backfill, not one each', async () => {
    const { app, rec, plugin } = await mkApp([ship(), ship({ name: 'other', field: 'reference' })])
    await plugin.boot!(app)
    expect(rec.hasHandler(BACKFILL_JOB)).toBe(true)
    await plugin.shutdown!(app)
  })

  // It starts itself: a backfill that had to be triggered by hand would put a
  // command between two deploys.
  test('queues the first chunk of an unfinished backfill', async () => {
    const { app, db, rec, plugin } = await mkApp([ship()])
    await seed(db, 3)
    await plugin.boot!(app)
    expect(rec.sent.map(s => s.data.name)).toEqual(['ship'])
    await plugin.shutdown!(app)
  })

  test('autoStart false records the run and queues nothing', async () => {
    const { app, db, rec, plugin, api } = await mkApp([ship()], { autoStart: false })
    await seed(db, 3)
    await plugin.boot!(app)
    expect(rec.sent).toHaveLength(0)
    expect((await api().status()).map((r: any) => r.name)).toEqual(['ship'])
    await plugin.shutdown!(app)
  })
})

// ─── the chain ───────────────────────────────────────────────────────────────

describe('the chain', () => {
  test('each chunk queues the next, and the short one ends it', async () => {
    const { app, db, rec, plugin, api } = await mkApp([ship()])
    await seed(db, 12)
    await plugin.boot!(app)
    await rec.drain()

    expect(await db.asSystem().order.count({ where: { shippedAt: null } })).toBe(0)
    const [row] = await api().status()
    expect(row.status).toBe('done')
    expect(row.filled).toBe(12)
    // Nothing left queued: the chunk that finished did not kick a successor.
    expect(rec.sent).toHaveLength(0)
    await plugin.shutdown!(app)
  })

  // The throttle. duty 0.5 means the gap equals the work.
  test('the next chunk carries a delay proportional to what the last cost', async () => {
    const { app, db, rec, plugin } = await mkApp([ship()])
    await seed(db, 12)
    await plugin.boot!(app)

    const first = rec.sent[0]
    expect(first.opts.delay).toBe(0)          // boot does not wait
    await rec.drain(1)
    expect(rec.sent[0].opts.delay).toBeGreaterThanOrEqual(0)
    expect(typeof rec.sent[0].opts.delay).toBe('number')
    await plugin.shutdown!(app)
  })

  // The cursor is in the id, which is what makes both a re-kick at boot and a
  // second replica's dispatch one row rather than two.
  test('the chunk id carries the cursor, so re-kicking the same position is one row', async () => {
    const { app, db, rec, plugin, api } = await mkApp([ship()])
    await seed(db, 12)
    await plugin.boot!(app)
    const firstId = rec.sent[0].opts.id

    await api().start('ship')      // the same position, asked for again
    expect(rec.sent).toHaveLength(1)
    expect(rec.sent[0].opts.id).toBe(firstId)
    await plugin.shutdown!(app)
  })

  // A deploy that removed the file is a deliberate act, not a fault to retry.
  test('a queued chunk for a backfill this build no longer declares is dropped', async () => {
    const { app, db, rec, plugin } = await mkApp([ship()])
    await seed(db, 3)
    await plugin.boot!(app)
    rec.sent[0].data.name = 'gone'
    await expect(rec.drain()).resolves.toBeUndefined()
    await plugin.shutdown!(app)
  })

  test('a chunk that throws records the failure and rethrows for the queue to retry', async () => {
    const { app, db, rec, plugin, api } = await mkApp([
      ship({ fill: () => { throw new Error('the fill blew up') } }),
    ])
    await seed(db, 3)
    await plugin.boot!(app)
    await expect(rec.drain()).rejects.toThrow(/the fill blew up/)

    const [row] = await api().status()
    expect(row.status).toBe('failed')
    expect(row.lastError).toContain('the fill blew up')
    expect(row.attempts).toBe(1)
    await plugin.shutdown!(app)
  })
})

// ─── pause ───────────────────────────────────────────────────────────────────

describe('pause and resume', () => {
  test('pause stops the chain and keeps its place; resume restarts it', async () => {
    const { app, db, rec, plugin, api } = await mkApp([ship()])
    await seed(db, 12)
    await plugin.boot!(app)
    await rec.drain(1)                       // one chunk, five rows

    await api().pause('ship')
    rec.sent.length = 0
    await api().start('ship')                // start declines a paused run
    expect(rec.sent).toHaveLength(0)
    expect(await db.asSystem().order.count({ where: { shippedAt: null } })).toBe(7)

    await api().resume('ship')
    await rec.drain()
    expect(await db.asSystem().order.count({ where: { shippedAt: null } })).toBe(0)
    await plugin.shutdown!(app)
  })
})

// ─── what /metrics answers ───────────────────────────────────────────────────

describe('metrics', () => {
  // The source must be SYNCHRONOUS — /metrics assigns `fn()` straight into the
  // body, so a promise would serialise as `{}`. It is refreshed by the sweep.
  test('answers a plain object, keyed by backfill, and never a promise', async () => {
    const { app, db, plugin, metrics } = await mkApp([ship()])
    await seed(db, 3)
    await plugin.boot!(app)

    const value = metrics.backfills()
    expect(value).not.toHaveProperty('then')
    expect(value).toHaveProperty('ship')
    expect((value as any).ship.status).toBeDefined()
    await plugin.shutdown!(app)
  })
})
