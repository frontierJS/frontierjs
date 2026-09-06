// tests/outbox-relay.test.ts
//
// The relay's two costs: what a row that CANNOT be delivered costs, and what
// walking the databases costs (`FJS-778`).
//
// A row that fails was retried on every tick of the relay's clock, forever —
// measured, twelve passes over an unroutable job left `attempts: 12` and a row
// still owed, and nothing anywhere reported that the effect was never going to
// happen. And the walk that finds the rows used `registry.get(id)`, which is
// the REQUEST path's verb: it promotes into litestone's pool, so a relay's
// timer sweeping 20 tenants evicted the tenant currently being served, three
// times per pass.
//
// Two shapes of assertion here, and neither is optional:
//
//   PAIRED     — every refusal sits beside the acceptance of a row one attempt
//                different, because a cap that gave up on everything and a
//                walk that reached nobody both satisfy a test that only checks
//                the refusal (`FJS-351`). The pool assertions are paired the
//                other way: the served tenant surviving is only evidence if
//                the walk it survived actually delivered something.
//
//   REAL POOL  — the tenant rows here run against `createTenantRegistry`, not
//                the Map that stands in for one in `outbox.test.ts`. A fake
//                registry has no pool, no cold path and no eviction, so every
//                claim this file makes about the walk is invisible from it.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join }   from 'node:path'

import { createClient, createTenantRegistry } from '../../litestone/src/index.js'
import { deliverOutbox, sweepOutbox, outboxCounts, outboxPass,
         assertOutboxShape } from '../src/core/outbox.ts'
import type { App } from '../src/core/app.ts'

const OUTBOX = await Bun.file(new URL('../db/outbox.lite', import.meta.url)).text()

const MODELS = `
model Post {
  id    Int    @id @default(autoincrement())
  title String
  @@db(main)
}
`

const SCHEMA = `database main { path "./app.db" }\n${MODELS}\n${OUTBOX}`

const mkDb = () => createClient({ databases: ':memory:', schema: SCHEMA }) as unknown as Promise<any>

/** A queue that answers, and one that refuses everything. */
const goodQueue = () => ({ dispatch: async () => 'job-id' })
const deadQueue = (msg = 'no handler registered') => ({
  dispatch: async () => { throw new Error(msg) },
})

/** A queue that refuses `n` times and then answers — the paired control. */
function flakyQueue(n: number) {
  let seen = 0
  return { dispatch: async () => { if (seen++ < n) throw new Error('not yet'); return 'job-id' } }
}

const enqueue = (db: any, job = 'order.shipped') =>
  db.asSystem().outboxMessage.create({ data: { job, payload: {} } })

const only = async (db: any) => (await db.asSystem().outboxMessage.findMany())[0]

/** Passes run back to back see one clock, so the backoff is stepped over. */
const rewind = (db: any, ms: number) =>
  db.asSystem().outboxMessage.updateMany({
    where: { deliveredAt: null },
    data:  { nextAttemptAt: new Date(Date.now() - ms) },
  })

// ─── the cap ──────────────────────────────────────────────────────────────────

describe('a row that cannot be delivered stops being tried', () => {

  test('attempts stop at the cap, and the row is still here with its error', async () => {
    const db  = await mkDb()
    const app = { db, jobs: deadQueue('nothing handles order.shipped') } as unknown as App
    await enqueue(db)

    // Twenty passes at a cap of three. Without the cap this is twenty
    // attempts; the backoff alone would not show it, because the rewind below
    // steps over exactly that.
    for (let i = 0; i < 20; i++) {
      await deliverOutbox(app, { maxAttempts: 3, retryBackoffMs: 1 })
      await rewind(db, 10_000)
    }

    const row = await only(db)
    expect(row.attempts).toBe(3)
    expect(row.deliveredAt).toBeNull()
    expect(row.lastError).toBe('nothing handles order.shipped')
    db.$close()
  })

  test('a row that recovers INSIDE the cap is delivered — the cap refuses one thing', async () => {
    const db  = await mkDb()
    const app = { db, jobs: flakyQueue(2) } as unknown as App
    await enqueue(db)

    for (let i = 0; i < 5; i++) {
      await deliverOutbox(app, { maxAttempts: 3, retryBackoffMs: 1 })
      await rewind(db, 10_000)
    }

    const row = await only(db)
    expect(row.deliveredAt).not.toBeNull()
    expect(row.attempts).toBe(3)
    db.$close()
  })

  test('maxAttempts: 0 never gives up — the behavior before there was a number', async () => {
    const db  = await mkDb()
    const app = { db, jobs: deadQueue() } as unknown as App
    await enqueue(db)

    for (let i = 0; i < 12; i++) {
      await deliverOutbox(app, { maxAttempts: 0, retryBackoffMs: 1 })
      await rewind(db, 10_000)
    }

    expect((await only(db)).attempts).toBe(12)
    db.$close()
  })

  test('raising the cap revives a dead row — dead is derived, never stamped', async () => {
    const db  = await mkDb()
    await enqueue(db)

    const dead = { db, jobs: deadQueue() } as unknown as App
    for (let i = 0; i < 4; i++) {
      await deliverOutbox(dead, { maxAttempts: 2, retryBackoffMs: 1 })
      await rewind(db, 10_000)
    }
    expect((await only(db)).attempts).toBe(2)
    expect(await outboxCounts(dead, { maxAttempts: 2 })).toEqual({ pending: 0, dead: 1 })

    // The handler is fixed and the operator raises the number. Nothing was
    // written to the row to undo, which is the whole point of not stamping it.
    const fixed = { db, jobs: goodQueue() } as unknown as App
    await deliverOutbox(fixed, { maxAttempts: 5, retryBackoffMs: 1 })

    expect((await only(db)).deliveredAt).not.toBeNull()
    db.$close()
  })
})

// ─── the backoff ──────────────────────────────────────────────────────────────

describe('a failed row waits, and a fresh one does not', () => {

  test('a failed row is NOT taken again on the very next pass', async () => {
    const db  = await mkDb()
    const app = { db, jobs: deadQueue() } as unknown as App
    await enqueue(db)

    await deliverOutbox(app, { retryBackoffMs: 60_000 })
    expect((await only(db)).attempts).toBe(1)

    // No rewind: the row's own `nextAttemptAt` is a minute out.
    await deliverOutbox(app, { retryBackoffMs: 60_000 })
    expect((await only(db)).attempts).toBe(1)
    db.$close()
  })

  test('…and IS taken once the wait has passed — the pair, or this proves nothing', async () => {
    const db  = await mkDb()
    const app = { db, jobs: deadQueue() } as unknown as App
    await enqueue(db)

    await deliverOutbox(app, { retryBackoffMs: 60_000 })
    await rewind(db, 61_000)
    await deliverOutbox(app, { retryBackoffMs: 60_000 })

    expect((await only(db)).attempts).toBe(2)
    db.$close()
  })

  test('a row that never failed carries no wait and goes on the first pass', async () => {
    const db  = await mkDb()
    await enqueue(db)
    await deliverOutbox({ db, jobs: goodQueue() } as unknown as App, { retryBackoffMs: 60_000 })
    expect((await only(db)).deliveredAt).not.toBeNull()
    db.$close()
  })

  test('the wait doubles, so a queue that is down is asked less and less', async () => {
    const db  = await mkDb()
    const app = { db, jobs: deadQueue() } as unknown as App
    await enqueue(db)

    const waits: number[] = []
    for (let i = 0; i < 4; i++) {
      const at = Date.now()
      await deliverOutbox(app, { retryBackoffMs: 1_000 })
      const row = await only(db)
      waits.push(Math.round((Date.parse(row.nextAttemptAt) - at) / 1_000))
      await rewind(db, 10 ** 6)
    }
    expect(waits).toEqual([1, 2, 4, 8])
    db.$close()
  })
})

// ─── what a count means ───────────────────────────────────────────────────────

describe('pending and dead are separate numbers', () => {

  test('a dead row leaves pending, or a readiness probe never comes back', async () => {
    const db  = await mkDb()
    const app = { db, jobs: deadQueue() } as unknown as App
    await enqueue(db, 'poison')

    for (let i = 0; i < 3; i++) {
      await deliverOutbox(app, { maxAttempts: 2, retryBackoffMs: 1 })
      await rewind(db, 10_000)
    }

    // A live row beside it on the same table, or *pending 0* cannot be told
    // from *the count is broken*.
    await enqueue(db, 'ordinary')

    expect(await outboxCounts(app, { maxAttempts: 2 })).toEqual({ pending: 1, dead: 1 })
    db.$close()
  })

  test('with no cap nothing is ever dead', async () => {
    const db  = await mkDb()
    const app = { db, jobs: deadQueue() } as unknown as App
    await enqueue(db)
    await deliverOutbox(app, { maxAttempts: 0, retryBackoffMs: 1 })
    expect(await outboxCounts(app, { maxAttempts: 0 })).toEqual({ pending: 1, dead: 0 })
    db.$close()
  })
})

// ─── the walk ─────────────────────────────────────────────────────────────────

/** A real registry: real files, a real pool, a real cold path. */
async function realRegistry(tenants: string[], maxOpen = 8) {
  const dir  = mkdtempSync(join(tmpdir(), 'outbox-relay-'))
  const text = `
database main { path "./app.db" }
tenancy {
  strategy database
  dir      "${dir}/tenants"
  registry "${dir}/registry.db"
  maxOpen  ${maxOpen}
}
${MODELS}
${OUTBOX}
`
  const path = join(dir, 'schema.lite')
  writeFileSync(path, text)

  const registry: any = await createTenantRegistry({ path })
  for (const id of tenants) await registry.create(id)
  return registry
}

describe('the walk does not evict the tenants being served', () => {

  test('a pass leaves the served tenant pooled, and still delivers', async () => {
    const ids      = Array.from({ length: 20 }, (_, i) => `t${i}`)
    const registry = await realRegistry(ids)

    // t19 is the tenant a request just went through: hot, and holding the row
    // this pass is about to deliver.
    const served = await registry.get('t19')
    await served.asSystem().outboxMessage.create({ data: { job: 'welcome', payload: {} } })
    expect(await registry.get('t19')).toBe(served)

    const app = { db: undefined, tenants: registry, jobs: goodQueue() } as unknown as App
    const out = await outboxPass(app, {}, 1_000)

    // Paired: the pool assertion below means nothing if the walk reached
    // nobody, and a walk that reached everybody by promoting them is the
    // defect. Both, on one pass.
    expect(out.delivered).toBe(1)
    expect(await registry.get('t19')).toBe(served)
  })

  test('a registry with no `query` still delivers — the duck-typed fallback', async () => {
    const dbs = new Map<string, any>()
    for (const id of ['acme', 'globex']) dbs.set(id, await mkDb())
    await dbs.get('acme').asSystem().outboxMessage.create({ data: { job: 'welcome', payload: {} } })

    const registry = { list: () => [...dbs.keys()], get: async (id: string) => dbs.get(id) }
    const app = { db: undefined, tenants: registry, jobs: goodQueue() } as unknown as App

    expect(await deliverOutbox(app)).toEqual({ delivered: 1, failed: 0 })
    for (const db of dbs.values()) db.$close()
  })

  test('one pass is ONE walk, where deliver + sweep + count were three', async () => {
    const dbs = new Map<string, any>()
    for (const id of ['acme', 'globex']) dbs.set(id, await mkDb())

    let walks = 0
    const registry = {
      list: () => [...dbs.keys()],
      get:  async (id: string) => dbs.get(id),
      query: async (fn: (db: unknown, id: string) => Promise<unknown>) => {
        walks++
        const out = []
        for (const [id, db] of dbs) out.push({ tenantId: id, result: await fn(db, id) })
        return out
      },
    }
    const app = { db: undefined, tenants: registry, jobs: goodQueue() } as unknown as App

    await outboxPass(app, {}, 1_000)
    expect(walks).toBe(1)

    walks = 0
    await deliverOutbox(app)
    await sweepOutbox(app, 1_000)
    await outboxCounts(app)
    expect(walks).toBe(3)

    for (const db of dbs.values()) db.$close()
  })

  test('the post-commit kick names its own database and walks nothing', async () => {
    const dbs = new Map<string, any>()
    for (const id of ['acme', 'globex']) dbs.set(id, await mkDb())
    await dbs.get('acme').asSystem().outboxMessage.create({ data: { job: 'welcome', payload: {} } })

    let walks = 0
    const registry = {
      list: () => { walks++; return [...dbs.keys()] },
      get:  async (id: string) => dbs.get(id),
    }
    const app = { db: undefined, tenants: registry, jobs: goodQueue() } as unknown as App

    const out = await deliverOutbox(app, { db: dbs.get('acme'), tenant: 'acme' })
    expect(out).toEqual({ delivered: 1, failed: 0 })
    expect(walks).toBe(0)

    for (const db of dbs.values()) db.$close()
  })

  test('boot opens no tenant — the shape question is answerable without one', async () => {
    const dbs = new Map<string, any>()
    dbs.set('acme', await mkDb())

    let opened = 0
    const registry = {
      list: () => [...dbs.keys()],
      get:  async (id: string) => { opened++; return dbs.get(id) },
    }
    await assertOutboxShape({ db: undefined, tenants: registry } as unknown as App)
    expect(opened).toBe(0)

    // Still refuses the shape it exists to refuse.
    const db = await mkDb()
    await expect(assertOutboxShape({ db, tenants: registry } as unknown as App))
      .rejects.toThrow(/BOTH createApp\({ db }\)/)

    db.$close()
    for (const d of dbs.values()) d.$close()
  })
})
